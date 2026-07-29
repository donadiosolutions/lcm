import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CHECK_IDENTITIES = Object.freeze({
  greptile: Object.freeze({
    name: "Greptile Review",
    appId: 867647,
    appSlug: "greptile-apps",
  }),
  dco: Object.freeze({ name: "DCO", appId: 1861, appSlug: "dco" }),
  ci: Object.freeze({ name: "ci", appId: 15368, appSlug: "github-actions" }),
});

export const ADMISSION_CLASSIFICATIONS = Object.freeze({
  greptileRequired: "greptile-required",
  greptileExcludedAuthor: "greptile-excluded-author",
  coverageNeutral: "no-coverable-or-trust-sensitive-files",
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

const GREPTILE_REQUIRED_PATHS = [
  /^(?:bin|installer|src)\/.+/u,
  /^scripts\/.*\.mjs$/u,
  /^\.github\/(?:actions|codeql|workflows|scripts)\/.+/u,
  /^package(?:-lock)?\.json$/u,
  /^greptile\.json$/u,
  /^vitest(?:\.[^/]+)?\.config\.[cm]?[jt]s$/u,
  /^tsconfig(?:\.[^/]+)?\.json$/u,
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

function requireRepositoryFullName(value, label) {
  const repository = requireNonEmptyString(value, label);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new TypeError(`${label} must be an owner/repository name`);
  }
  return repository;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireSafeNonNegativeInteger(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a safe non-negative integer`);
    }
    return value;
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed);
  }
  throw new TypeError(`${label} must be a safe non-negative integer`);
}

export function flattenPullRequestFilePages(pages) {
  return requireArray(pages, "pull request file pages").flatMap((page, index) =>
    requireArray(page, `pull request file page ${index}`));
}

export function flattenCheckRunPages(pages) {
  return requireArray(pages, "check run pages").flatMap((page, index) => {
    if (page === null || typeof page !== "object" || Array.isArray(page)) {
      throw new TypeError(`check run page ${index} must be an object`);
    }
    return requireArray(page.check_runs, `check run page ${index}.check_runs`);
  });
}

export function requiresGreptileForPath(path) {
  requireNonEmptyString(path, "pull request path");
  return GREPTILE_REQUIRED_PATHS.some((pattern) => pattern.test(path));
}

export function parseGreptileConfig(value) {
  const config = requireObject(value, "greptile configuration");
  if (config.excludeAuthors === undefined) return { excludeAuthors: [] };
  return {
    excludeAuthors: requireArray(config.excludeAuthors, "greptile excludeAuthors").map(
      (pattern, index) => requireNonEmptyString(pattern, `greptile excludeAuthors[${index}]`),
    ),
  };
}

export function readGreptileConfig(path) {
  requireNonEmptyString(path, "greptile configuration path");
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new TypeError("unable to read greptile configuration");
  }
  try {
    return parseGreptileConfig(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError("greptile configuration must contain valid JSON");
    }
    throw error;
  }
}

function globToRegularExpression(pattern) {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") {
      source += "[\\s\\S]*";
    } else if (character === "?") {
      source += "[\\s\\S]";
    } else {
      source += /[\\^$+?.()|{}\[\]]/u.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${source}$`, "iu");
}

export function matchesGreptileGlob(value, pattern) {
  requireNonEmptyString(value, "Greptile match value");
  requireNonEmptyString(pattern, "Greptile glob pattern");
  return globToRegularExpression(pattern).test(value);
}

export function excludedGreptileAuthorPattern(author, config) {
  requireNonEmptyString(author, "pull request author");
  const { excludeAuthors } = parseGreptileConfig(config);
  return excludeAuthors.find((pattern) => matchesGreptileGlob(author, pattern));
}

export function isTrustedAutomationPullRequest(pullRequest, greptileConfig) {
  if (pullRequest === null || typeof pullRequest !== "object" || Array.isArray(pullRequest)) {
    throw new TypeError("pull request must be an object");
  }
  const login = requireNonEmptyString(pullRequest.user?.login, "pull request user login");
  const type = requireNonEmptyString(pullRequest.user?.type, "pull request user type");
  const headRef = requireNonEmptyString(pullRequest.head?.ref, "pull request head ref");
  const headRepository = requireRepositoryFullName(
    pullRequest.head?.repo?.full_name,
    "pull request head repository",
  );
  const baseRepository = requireRepositoryFullName(
    pullRequest.base?.repo?.full_name,
    "pull request base repository",
  );
  return login === "dependabot[bot]"
    && type === "Bot"
    && headRef.startsWith("dependabot/")
    && headRef.length > "dependabot/".length
    && !/\s/u.test(headRef)
    && headRepository === baseRepository
    && excludedGreptileAuthorPattern(login, greptileConfig) !== undefined;
}

export function selectAdmissionRequirement(
  pullRequest,
  sensitiveDiff,
  changesGreptileExclusionPolicy,
  greptileConfig,
) {
  if (typeof sensitiveDiff !== "boolean") {
    throw new TypeError("sensitive diff must be a boolean");
  }
  if (typeof changesGreptileExclusionPolicy !== "boolean") {
    throw new TypeError("greptile exclusion-policy change must be a boolean");
  }
  const excludedAuthorPattern = excludedGreptileAuthorPattern(
    requireNonEmptyString(pullRequest?.user?.login, "pull request user login"),
    greptileConfig,
  );
  const trustedAutomation = isTrustedAutomationPullRequest(pullRequest, greptileConfig);
  const greptileRequired = sensitiveDiff
    && (!trustedAutomation || changesGreptileExclusionPolicy);
  return {
    classification: sensitiveDiff
      ? (greptileRequired
        ? ADMISSION_CLASSIFICATIONS.greptileRequired
        : ADMISSION_CLASSIFICATIONS.greptileExcludedAuthor)
      : ADMISSION_CLASSIFICATIONS.coverageNeutral,
    sensitiveDiff,
    trustedAutomation,
    greptileRequired,
    excludedAuthorPattern,
  };
}

export function admissionDecision(requirement) {
  const value = requireObject(requirement, "admission requirement");
  const excludedAuthorPattern = value.excludedAuthorPattern;
  return {
    classification: requireNonEmptyString(
      value.classification,
      "admission requirement.classification",
    ),
    greptileRequired: requireBoolean(
      value.greptileRequired,
      "admission requirement.greptileRequired",
    ),
    excludedAuthorPattern: excludedAuthorPattern === undefined || excludedAuthorPattern === null
      ? null
      : requireNonEmptyString(
        excludedAuthorPattern,
        "admission requirement.excludedAuthorPattern",
      ),
  };
}

export function classifyPullRequestFiles(files, expectedCount) {
  const fileRecords = requireArray(files, "pull request files");
  const authoritativeCount = requireSafeNonNegativeInteger(
    expectedCount,
    "expected pull request file count",
  );
  if (fileRecords.length !== authoritativeCount) {
    throw new TypeError("pull request file audit count does not match changed_files");
  }
  if (fileRecords.length === 0) {
    throw new TypeError("pull request files must not be empty");
  }

  const auditedPaths = [];
  for (const [index, file] of fileRecords.entries()) {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      throw new TypeError(`pull request file ${index} must be an object`);
    }
    auditedPaths.push(requireNonEmptyString(file.filename, `pull request file ${index}.filename`));
    if (file.previous_filename !== undefined && file.previous_filename !== null) {
      auditedPaths.push(requireNonEmptyString(
        file.previous_filename,
        `pull request file ${index}.previous_filename`,
      ));
    }
  }

  const uniquePaths = [...new Set(auditedPaths)];
  const matchedPaths = uniquePaths.filter(requiresGreptileForPath);
  const greptileRequired = matchedPaths.length > 0;
  return {
    classification: greptileRequired
      ? ADMISSION_CLASSIFICATIONS.greptileRequired
      : ADMISSION_CLASSIFICATIONS.coverageNeutral,
    greptileRequired,
    auditedPaths: uniquePaths,
    matchedPaths,
  };
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
  greptileRequired,
  repository,
  serverUrl = "https://github.com",
}) {
  requireNonEmptyString(headSha, "head SHA");
  const checks = {
    greptile: latestAuthenticatedCheck(checkRuns, CHECK_IDENTITIES.greptile, headSha),
    dco: latestAuthenticatedCheck(checkRuns, CHECK_IDENTITIES.dco, headSha),
    ci: latestAuthenticatedCheck(checkRuns, CHECK_IDENTITIES.ci, headSha),
  };
  const states = Object.fromEntries(
    Object.entries(checks).map(([name, check]) => [name, checkState(check)]),
  );
  const requiredNames = greptileRequired ? ["greptile", "dco"] : ["ci", "dco"];
  const terminalFailure = requiredNames.find((name) =>
    states[name] !== "success" && !WAITING_CHECK_STATES.has(states[name]));

  let ciRunId;
  let invalidCiRunUrl = false;
  if (!greptileRequired && states.ci === "success") {
    ciRunId = parseActionsRunId(checks.ci?.details_url, { repository, serverUrl });
    invalidCiRunUrl = ciRunId === undefined;
  }

  return {
    states,
    requiredNames,
    ready: terminalFailure === undefined
      && !invalidCiRunUrl
      && requiredNames.every((name) => states[name] === "success"),
    terminalFailure: terminalFailure ?? (invalidCiRunUrl ? "ci-run-url" : undefined),
    ciRunId,
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

export function runPolicyCommand(command, args, input) {
  requireArray(args, "policy command arguments");
  requireNonEmptyString(input, "policy command input");
  const payload = JSON.parse(input);

  if (command === "classify-files" && args.length === 1) {
    return JSON.stringify(classifyPullRequestFiles(flattenPullRequestFilePages(payload), args[0]));
  }
  if (command === "select-admission" && args.length === 3) {
    const [sensitiveDiff, changesGreptileExclusionPolicy, configPath] = args;
    if (sensitiveDiff !== "true" && sensitiveDiff !== "false") {
      throw new TypeError("sensitive-diff argument must be true or false");
    }
    if (changesGreptileExclusionPolicy !== "true" && changesGreptileExclusionPolicy !== "false") {
      throw new TypeError("greptile-exclusion-policy-change argument must be true or false");
    }
    return JSON.stringify(selectAdmissionRequirement(
      payload,
      sensitiveDiff === "true",
      changesGreptileExclusionPolicy === "true",
      readGreptileConfig(configPath),
    ));
  }
  if (command === "admission-decision" && args.length === 0) {
    return JSON.stringify(admissionDecision(payload));
  }
  if (command === "evaluate-checks" && args.length === 4) {
    const [headSha, greptileRequired, repository, serverUrl] = args;
    if (greptileRequired !== "true" && greptileRequired !== "false") {
      throw new TypeError("greptile-required argument must be true or false");
    }
    return JSON.stringify(evaluateAdmissionChecks({
      checkRuns: flattenCheckRunPages(payload),
      headSha,
      greptileRequired: greptileRequired === "true",
      repository,
      serverUrl,
    }));
  }
  if (command === "evaluate-ci-run" && args.length === 3) {
    const [runId, headSha, repository] = args;
    return JSON.stringify(evaluateCiActionsRun(payload, { runId, headSha, repository }));
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
