import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ADMISSION_CLASSIFICATIONS,
  CHECK_IDENTITIES,
  admissionDecision,
  classifyPullRequestFiles,
  excludedGreptileAuthorPattern,
  evaluateAdmissionChecks,
  evaluateCiActionsRun,
  flattenCheckRunPages,
  flattenPullRequestFilePages,
  isTrustedAutomationPullRequest,
  matchesGreptileGlob,
  parseActionsRunId,
  parseGreptileConfig,
  requiresGreptileForPath,
  runPolicyCommand,
  selectAdmissionRequirement,
} from "./external-admission-policy.mjs";

const HEAD_SHA = "a".repeat(40);
const REPOSITORY = "donadiosolutions/lcm";

function check(identity, overrides = {}) {
  return {
    id: 1,
    name: identity.name,
    head_sha: HEAD_SHA,
    app: { id: identity.appId, slug: identity.appSlug },
    status: "completed",
    conclusion: "success",
    details_url: `https://github.com/${REPOSITORY}/actions/runs/123/job/456`,
    ...overrides,
  };
}

function pullRequest({
  login = "dependabot[bot]",
  type = "Bot",
  headRef = "dependabot/npm_and_yarn/runtime-dependencies",
  headRepository = REPOSITORY,
  baseRepository = REPOSITORY,
} = {}) {
  return {
    user: { login, type },
    head: { ref: headRef, repo: { full_name: headRepository } },
    base: { ref: "main", repo: { full_name: baseRepository } },
  };
}

test("classifies every coverable and trust-sensitive path family", () => {
  for (const path of [
    "bin/lcm.ts",
    "bin/lcm",
    "bin/nested/tool.js",
    "installer/install.ts",
    "installer/setup.sh",
    "src/index.ts",
    "src/index.js",
    "src/prompts/system.yaml",
    "src/connectors/templates/base.md",
    "src/storage/postgresql/migrations/001_initial.sql",
    "scripts/build-runtime.mjs",
    "scripts/release/channel/select.mjs",
    ".github/codeql/security-extended.yml",
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    ".github/scripts/external-admission-policy.mjs",
    "greptile.json",
    "package.json",
    "package-lock.json",
    "vitest.config.ts",
    "vitest.unit.config.mts",
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    assert.equal(requiresGreptileForPath(path), true, path);
  }
});

test("keeps documentation, tests, and unrelated metadata coverage-neutral", () => {
  for (const path of [
    "README.md",
    "docs/configuration.md",
    "test/daemon/config.test.ts",
    ".changeset/example.md",
    ".github/copilot-instructions.md",
    "scripts/update-gitleaks-patterns.ts",
    "scripts/harvest-themes.sh",
    "scripts/release/channel/select.js",
    "nested/src/index.ts",
  ]) {
    assert.equal(requiresGreptileForPath(path), false, path);
  }
});

test("trusts only authoritative same-repository Dependabot provenance", () => {
  const greptileConfig = {
    excludeAuthors: ["dependabot[bot]", "github-actions[bot]", "*"],
  };
  assert.equal(
    isTrustedAutomationPullRequest(pullRequest(), greptileConfig),
    true,
  );
  for (const candidate of [
    pullRequest({ login: "github-actions[bot]", headRef: "changeset-release/main" }),
    pullRequest({ login: "renovate[bot]", headRef: "dependabot/npm_and_yarn/dependencies" }),
    pullRequest({ login: "Dependabot[bot]" }),
    pullRequest({ type: "User" }),
    pullRequest({ headRef: "changeset-release/main" }),
    pullRequest({ headRef: "dependabot/" }),
    pullRequest({ headRef: "dependabot/npm and yarn/runtime" }),
    pullRequest({ headRepository: "attacker/lcm" }),
    pullRequest({ baseRepository: "other/lcm" }),
  ]) {
    assert.equal(
      isTrustedAutomationPullRequest(candidate, greptileConfig),
      false,
      JSON.stringify(candidate),
    );
  }
  for (const malformedPullRequest of [
    undefined,
    null,
    [],
    {},
    { user: {} },
    { ...pullRequest(), head: undefined },
    { ...pullRequest(), head: { ref: "", repo: { full_name: REPOSITORY } } },
    { ...pullRequest(), head: { ref: "dependabot/npm", repo: {} } },
    { ...pullRequest(), base: undefined },
    { ...pullRequest(), base: { ref: "main", repo: { full_name: "invalid" } } },
  ]) {
    assert.throws(
      () => isTrustedAutomationPullRequest(malformedPullRequest, greptileConfig),
      /pull request|user|head|base|repository/u,
      JSON.stringify(malformedPullRequest),
    );
  }
});

test("selects Greptile or CI from sensitive classification and authoritative identity", () => {
  const human = pullRequest({
    login: "bcdonadio",
    type: "User",
    headRef: "fix/security-boundary",
  });
  const dependabot = pullRequest();
  const greptileConfig = { excludeAuthors: ["dependabot[bot]"] };
  assert.deepEqual(selectAdmissionRequirement(human, true, false, greptileConfig), {
    classification: ADMISSION_CLASSIFICATIONS.greptileRequired,
    sensitiveDiff: true,
    trustedAutomation: false,
    greptileRequired: true,
    excludedAuthorPattern: undefined,
  });
  assert.deepEqual(selectAdmissionRequirement(dependabot, true, false, greptileConfig), {
    classification: ADMISSION_CLASSIFICATIONS.greptileExcludedAuthor,
    sensitiveDiff: true,
    trustedAutomation: true,
    greptileRequired: false,
    excludedAuthorPattern: "dependabot[bot]",
  });
  assert.deepEqual(selectAdmissionRequirement(dependabot, false, false, greptileConfig), {
    classification: ADMISSION_CLASSIFICATIONS.coverageNeutral,
    sensitiveDiff: false,
    trustedAutomation: true,
    greptileRequired: false,
    excludedAuthorPattern: "dependabot[bot]",
  });
  assert.deepEqual(selectAdmissionRequirement(dependabot, true, true, greptileConfig), {
    classification: ADMISSION_CLASSIFICATIONS.greptileRequired,
    sensitiveDiff: true,
    trustedAutomation: true,
    greptileRequired: true,
    excludedAuthorPattern: "dependabot[bot]",
  });
  assert.throws(
    () => selectAdmissionRequirement(human, "true", false, greptileConfig),
    /must be a boolean/u,
  );
  assert.throws(
    () => selectAdmissionRequirement(human, true, "false", greptileConfig),
    /must be a boolean/u,
  );
});

test("requires Greptile for changeset release automation and invalid Dependabot provenance", () => {
  const greptileConfig = {
    excludeAuthors: ["dependabot[bot]", "github-actions[bot]", "*"],
  };
  for (const candidate of [
    pullRequest({ login: "github-actions[bot]", headRef: "changeset-release/main" }),
    pullRequest({ headRef: "changeset-release/main" }),
    pullRequest({ headRepository: "attacker/lcm" }),
  ]) {
    const requirement = selectAdmissionRequirement(
      candidate,
      true,
      false,
      greptileConfig,
    );
    assert.equal(requirement.classification, ADMISSION_CLASSIFICATIONS.greptileRequired);
    assert.equal(requirement.sensitiveDiff, true);
    assert.equal(requirement.trustedAutomation, false);
    assert.equal(requirement.greptileRequired, true);
    assert.equal(typeof requirement.excludedAuthorPattern, "string");
  }
});

test("compares only decision-driving fields across reordered file audits", () => {
  const requirement = {
    classification: ADMISSION_CLASSIFICATIONS.greptileExcludedAuthor,
    greptileRequired: false,
    excludedAuthorPattern: "dependabot[bot]",
    sensitiveDiff: true,
    trustedAutomation: true,
    auditedPaths: ["package-lock.json", "docs/changelog.md"],
  };
  assert.deepEqual(admissionDecision({
    ...requirement,
    auditedPaths: [...requirement.auditedPaths].reverse(),
  }), admissionDecision(requirement));

  for (const changedDecision of [
    { ...requirement, classification: ADMISSION_CLASSIFICATIONS.greptileRequired },
    { ...requirement, greptileRequired: true },
    { ...requirement, excludedAuthorPattern: null },
  ]) {
    assert.notDeepEqual(admissionDecision(changedDecision), admissionDecision(requirement));
  }
  assert.deepEqual(admissionDecision({
    classification: ADMISSION_CLASSIFICATIONS.coverageNeutral,
    greptileRequired: false,
  }), {
    classification: ADMISSION_CLASSIFICATIONS.coverageNeutral,
    greptileRequired: false,
    excludedAuthorPattern: null,
  });
  assert.throws(() => admissionDecision({
    classification: ADMISSION_CLASSIFICATIONS.coverageNeutral,
    greptileRequired: "false",
  }), /greptileRequired/u);
});

test("matches Greptile excluded-author globs while requiring GitHub Bot type", () => {
  assert.equal(matchesGreptileGlob("Dependabot[Bot]", "dependabot[bot]"), true);
  assert.equal(matchesGreptileGlob("release-bot", "*-bot"), true);
  assert.equal(matchesGreptileGlob("bot", "?ot"), true);
  assert.equal(matchesGreptileGlob("!abot", "!abot"), true);
  assert.equal(matchesGreptileGlob("abot", "!abot"), false);
  assert.equal(matchesGreptileGlob("dependabotb", "dependabot[bot]"), false);
  assert.equal(excludedGreptileAuthorPattern("DEPENDABOT[BOT]", {
    excludeAuthors: ["dependabot[bot]"],
  }), "dependabot[bot]");
  assert.equal(isTrustedAutomationPullRequest(pullRequest({
    login: "release-bot",
    type: "User",
    headRef: "changeset-release/main",
  }), { excludeAuthors: ["*-bot"] }), false);
});

test("fails closed when the trusted Greptile configuration is malformed", () => {
  for (const config of [null, [], { excludeAuthors: "dependabot[bot]" }, {
    excludeAuthors: ["dependabot[bot]", 1],
  }, { excludeAuthors: [""] }]) {
    assert.throws(() => parseGreptileConfig(config), /greptile/u);
    assert.throws(() => selectAdmissionRequirement({
      user: { login: "dependabot[bot]", type: "Bot" },
      head: {
        ref: "dependabot/npm_and_yarn/runtime-dependencies",
        repo: { full_name: REPOSITORY },
      },
      base: { repo: { full_name: REPOSITORY } },
    }, true, false, config), /greptile/u);
  }
});

test("fails closed when the checked-out Greptile configuration cannot be parsed", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lcm-greptile-config-"));
  const configPath = join(temporaryDirectory, "greptile.json");
  try {
    writeFileSync(configPath, "{", "utf8");
    assert.throws(() => runPolicyCommand("select-admission", [
      "true",
      "false",
      configPath,
    ], JSON.stringify({
      user: { login: "dependabot[bot]", type: "Bot" },
      head: {
        ref: "dependabot/npm_and_yarn/runtime-dependencies",
        repo: { full_name: REPOSITORY },
      },
      base: { repo: { full_name: REPOSITORY } },
    })), /valid JSON/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("audits both current and previous rename paths without duplicates", () => {
  assert.deepEqual(classifyPullRequestFiles([
    { filename: "docs/new.md", previous_filename: "src/old.ts" },
    { filename: "docs/new.md" },
  ], 2), {
    classification: ADMISSION_CLASSIFICATIONS.greptileRequired,
    greptileRequired: true,
    auditedPaths: ["docs/new.md", "src/old.ts"],
    matchedPaths: ["src/old.ts"],
  });
});

test("classifies a complete neutral file list", () => {
  assert.deepEqual(classifyPullRequestFiles([
    { filename: "docs/guide.md" },
    { filename: "test/guide.test.ts", previous_filename: null },
  ], "2"), {
    classification: ADMISSION_CLASSIFICATIONS.coverageNeutral,
    greptileRequired: false,
    auditedPaths: ["docs/guide.md", "test/guide.test.ts"],
    matchedPaths: [],
  });
});

test("rejects malformed or incomplete file audits", () => {
  for (const value of [undefined, null, {}, "files"]) {
    assert.throws(() => classifyPullRequestFiles(value, 1), /must be an array/u);
  }
  assert.throws(() => classifyPullRequestFiles([], 0), /must not be empty/u);
  assert.throws(() => classifyPullRequestFiles([null], 1), /must be an object/u);
  assert.throws(() => classifyPullRequestFiles([{}], 1), /filename/u);
  assert.throws(
    () => classifyPullRequestFiles([{ filename: "docs/a.md", previous_filename: 1 }], 1),
    /previous_filename/u,
  );
  assert.throws(() => requiresGreptileForPath(""), /non-empty string/u);
});

test("requires an exact safe authoritative changed-files count", () => {
  const cappedFileResponse = Array.from(
    { length: 3_000 },
    (_, index) => ({ filename: `docs/file-${index}.md` }),
  );
  assert.equal(classifyPullRequestFiles(cappedFileResponse, 3_000).greptileRequired, false);
  for (const mismatchedCount of [2_999, 3_001]) {
    assert.throws(
      () => classifyPullRequestFiles(cappedFileResponse, mismatchedCount),
      /does not match changed_files/u,
      String(mismatchedCount),
    );
  }
  for (const malformedCount of [
    undefined,
    null,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "-1",
    "01",
    "1.5",
    "9007199254740992",
    {},
  ]) {
    assert.throws(
      () => classifyPullRequestFiles([{ filename: "docs/a.md" }], malformedCount),
      /safe non-negative integer/u,
      String(malformedCount),
    );
  }
});

test("flattens every pull request file page and rejects malformed pages", () => {
  assert.deepEqual(flattenPullRequestFilePages([
    [{ filename: "one" }],
    [{ filename: "two" }, { filename: "three" }],
  ]), [{ filename: "one" }, { filename: "two" }, { filename: "three" }]);
  assert.throws(() => flattenPullRequestFilePages({}), /must be an array/u);
  assert.throws(() => flattenPullRequestFilePages([{}]), /page 0 must be an array/u);
});

test("flattens every check-run page and rejects malformed pages", () => {
  assert.deepEqual(flattenCheckRunPages([
    { check_runs: [{ id: 1 }] },
    { check_runs: [{ id: 2 }, { id: 3 }] },
  ]), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.throws(() => flattenCheckRunPages({}), /must be an array/u);
  assert.throws(() => flattenCheckRunPages([null]), /page 0 must be an object/u);
  assert.throws(() => flattenCheckRunPages([{}]), /check_runs must be an array/u);
});

test("requires exact authenticated Greptile and DCO checks for sensitive diffs", () => {
  const evaluation = evaluateAdmissionChecks({
    checkRuns: [check(CHECK_IDENTITIES.greptile), check(CHECK_IDENTITIES.dco, { id: 2 })],
    headSha: HEAD_SHA,
    greptileRequired: true,
    repository: REPOSITORY,
  });
  assert.deepEqual(evaluation.requiredNames, ["greptile", "dco"]);
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.ciRunId, undefined);
});

test("requires exact authenticated CI and DCO checks for neutral diffs", () => {
  const evaluation = evaluateAdmissionChecks({
    checkRuns: [check(CHECK_IDENTITIES.ci), check(CHECK_IDENTITIES.dco, { id: 2 })],
    headSha: HEAD_SHA,
    greptileRequired: false,
    repository: REPOSITORY,
  });
  assert.deepEqual(evaluation.requiredNames, ["ci", "dco"]);
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.ciRunId, "123");
});

test("ignores spoofed, wrong-head, and older authenticated check runs", () => {
  const evaluation = evaluateAdmissionChecks({
    checkRuns: [
      check(CHECK_IDENTITIES.ci, { id: 10, conclusion: "failure" }),
      check(CHECK_IDENTITIES.ci, { id: 11, head_sha: "b".repeat(40) }),
      check(CHECK_IDENTITIES.ci, { id: 12, app: { id: 999, slug: "github-actions" } }),
      check(CHECK_IDENTITIES.ci, { id: 13, app: { id: 15368, slug: "spoof" } }),
      check(CHECK_IDENTITIES.ci, { id: 14, conclusion: "success" }),
      check(CHECK_IDENTITIES.dco, { id: 15 }),
    ],
    headSha: HEAD_SHA,
    greptileRequired: false,
    repository: REPOSITORY,
  });
  assert.equal(evaluation.ready, true);
});

test("distinguishes waiting checks from terminal failures", () => {
  const waiting = evaluateAdmissionChecks({
    checkRuns: [
      check(CHECK_IDENTITIES.greptile, { status: "in_progress", conclusion: null }),
      check(CHECK_IDENTITIES.dco, { id: 2 }),
    ],
    headSha: HEAD_SHA,
    greptileRequired: true,
    repository: REPOSITORY,
  });
  assert.equal(waiting.ready, false);
  assert.equal(waiting.terminalFailure, undefined);

  const failed = evaluateAdmissionChecks({
    checkRuns: [
      check(CHECK_IDENTITIES.greptile, { conclusion: "failure" }),
      check(CHECK_IDENTITIES.dco, { id: 2 }),
    ],
    headSha: HEAD_SHA,
    greptileRequired: true,
    repository: REPOSITORY,
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.terminalFailure, "greptile");
});

test("rejects a successful CI check without a trusted Actions run URL", () => {
  for (const detailsUrl of [
    undefined,
    "not a URL",
    `http://github.com/${REPOSITORY}/actions/runs/123/job/456`,
    `https://example.com/${REPOSITORY}/actions/runs/123/job/456`,
    "https://github.com/other/repo/actions/runs/123/job/456",
    `https://github.com/${REPOSITORY}/actions/runs/not-a-number/job/456`,
  ]) {
    const evaluation = evaluateAdmissionChecks({
      checkRuns: [
        check(CHECK_IDENTITIES.ci, { details_url: detailsUrl }),
        check(CHECK_IDENTITIES.dco, { id: 2 }),
      ],
      headSha: HEAD_SHA,
      greptileRequired: false,
      repository: REPOSITORY,
    });
    assert.equal(evaluation.ready, false, String(detailsUrl));
    assert.equal(evaluation.terminalFailure, "ci-run-url", String(detailsUrl));
  }
});

test("parses a trusted positive Actions run id as digits without truncation", () => {
  assert.equal(parseActionsRunId(
    `https://github.com/${REPOSITORY}/actions/runs/987654/job/123`,
    { repository: REPOSITORY },
  ), "987654");
  assert.equal(parseActionsRunId(
    `https://github.com/${REPOSITORY}/actions/runs/0`,
    { repository: REPOSITORY },
  ), undefined);
  assert.equal(parseActionsRunId(
    `https://github.com/${REPOSITORY}/actions/runs/99999999999999999999/job/123`,
    { repository: REPOSITORY },
  ), "99999999999999999999");
});

test("rejects unsafe or non-positive authenticated check IDs", () => {
  for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1, "0", "1.5", undefined]) {
    assert.throws(() => evaluateAdmissionChecks({
      checkRuns: [check(CHECK_IDENTITIES.greptile, { id })],
      headSha: HEAD_SHA,
      greptileRequired: true,
      repository: REPOSITORY,
    }), /check run ID/u, String(id));
  }
});

test("waits for every documented transient CI Actions run state", () => {
  const valid = {
    id: 123,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: HEAD_SHA,
    repository: { full_name: REPOSITORY },
  };

  for (const status of ["queued", "in_progress", "pending", "requested", "waiting"]) {
    assert.deepEqual(evaluateCiActionsRun({ ...valid, status, conclusion: null }, {
      runId: "123",
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), {
      state: status,
      ready: false,
      terminalFailure: undefined,
    }, status);
  }
});

test("accepts only terminal success and rejects every terminal non-success", () => {
  const valid = {
    id: 123,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: HEAD_SHA,
    status: "completed",
    repository: { full_name: REPOSITORY },
  };
  assert.deepEqual(evaluateCiActionsRun({ ...valid, conclusion: "success" }, {
    runId: "123",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  }), { state: "success", ready: true, terminalFailure: undefined });

  for (const conclusion of [
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "timed_out",
  ]) {
    assert.deepEqual(evaluateCiActionsRun({ ...valid, conclusion }, {
      runId: "123",
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), { state: conclusion, ready: false, terminalFailure: "ci-run" }, conclusion);
  }
  assert.deepEqual(evaluateCiActionsRun({ ...valid, conclusion: null }, {
    runId: "123",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  }), { state: "missing", ready: false, terminalFailure: "ci-run" });
});

test("rejects malformed states and every CI Actions run provenance mismatch", () => {
  const valid = {
    id: 123,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
  };

  for (const status of [undefined, null, "unknown"]) {
    assert.deepEqual(evaluateCiActionsRun({ ...valid, status }, {
      runId: "123",
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), {
      state: status === "unknown" ? "unknown" : "missing",
      ready: false,
      terminalFailure: "ci-run",
    }, String(status));
  }

  for (const [field, value] of [
    ["id", 124],
    ["event", "push"],
    ["path", ".github/workflows/other.yml"],
    ["head_sha", "b".repeat(40)],
    ["repository", { full_name: "other/repo" }],
  ]) {
    assert.deepEqual(evaluateCiActionsRun({ ...valid, [field]: value }, {
      runId: 123,
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), { state: "invalid", ready: false, terminalFailure: "ci-run-metadata" }, field);
  }
  assert.deepEqual(evaluateCiActionsRun(null, {
    runId: "123",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  }), { state: "invalid", ready: false, terminalFailure: "ci-run-metadata" });
});

test("exposes the complete policy through its deterministic CLI command seam", () => {
  const classification = JSON.parse(runPolicyCommand("classify-files", ["1"], JSON.stringify([
    [{ filename: "docs/new.md", previous_filename: "src/old.ts" }],
  ])));
  assert.equal(classification.greptileRequired, true);

  const evaluation = JSON.parse(runPolicyCommand("evaluate-checks", [
    HEAD_SHA,
    "false",
    REPOSITORY,
    "https://github.com",
  ], JSON.stringify([{ check_runs: [
    check(CHECK_IDENTITIES.ci),
    check(CHECK_IDENTITIES.dco, { id: 2 }),
  ] }] )));
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.ciRunId, "123");
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "admission-decision",
    [],
    JSON.stringify({
      classification: ADMISSION_CLASSIFICATIONS.greptileExcludedAuthor,
      greptileRequired: false,
      excludedAuthorPattern: "dependabot[bot]",
      auditedPaths: ["second", "first"],
    }),
  )), {
    classification: ADMISSION_CLASSIFICATIONS.greptileExcludedAuthor,
    greptileRequired: false,
    excludedAuthorPattern: "dependabot[bot]",
  });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "select-admission",
    ["true", "false", "greptile.json"],
    JSON.stringify(pullRequest()),
  )), {
    classification: ADMISSION_CLASSIFICATIONS.greptileExcludedAuthor,
    sensitiveDiff: true,
    trustedAutomation: true,
    greptileRequired: false,
    excludedAuthorPattern: "dependabot[bot]",
  });

  const run = {
    id: 123,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
  };
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-ci-run",
    ["123", HEAD_SHA, REPOSITORY],
    JSON.stringify(run),
  )), { state: "success", ready: true });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-ci-run",
    ["0", HEAD_SHA, REPOSITORY],
    JSON.stringify(run),
  )), { state: "invalid", ready: false, terminalFailure: "ci-run-metadata" });
  assert.throws(() => runPolicyCommand("evaluate-checks", [
    HEAD_SHA,
    "maybe",
    REPOSITORY,
    "https://github.com",
  ], "{}"), /true or false/u);
  assert.throws(() => runPolicyCommand("select-admission", [
    "maybe", "false", "greptile.json",
  ], "{}"), /true or false/u);
  assert.throws(() => runPolicyCommand("select-admission", [
    "true", "maybe", "greptile.json",
  ], "{}"), /true or false/u);
  assert.throws(() => runPolicyCommand("unknown", [], "{}"), /unknown policy command/u);
  assert.throws(() => runPolicyCommand("classify-files", ["1"], ""), /non-empty/u);
  assert.throws(() => runPolicyCommand("classify-files", [], "[]"), /unknown policy command/u);
  assert.throws(
    () => runPolicyCommand("classify-files", ["2"], "[[{\"filename\":\"docs/a.md\"}]]"),
    /does not match changed_files/u,
  );
  assert.throws(
    () => runPolicyCommand("classify-files", ["9007199254740992"], "[[{\"filename\":\"docs/a.md\"}]]"),
    /safe non-negative integer/u,
  );
});
