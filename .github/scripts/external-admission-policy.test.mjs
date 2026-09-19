import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMISSION_CLASSIFICATIONS,
  CHECK_IDENTITIES,
  classifyPullRequestFiles,
  evaluateAdmissionChecks,
  evaluateCiActionsRun,
  evaluateEventFreshness,
  evaluatePullRequestEligibility,
  evaluateReviewActionsRun,
  evaluateReviewCheck,
  evaluateSensitiveAdmission,
  flattenCheckRunPages,
  flattenPullRequestFilePages,
  parseActionsRunId,
  runPolicyCommand,
} from "./external-admission-policy.mjs";

const HEAD_SHA = "a".repeat(40);
const REPOSITORY = "donadiosolutions/lcm";
const eligibleMain = {
  number: 123,
  changed_files: 1,
  commits: 1,
  state: "open",
  draft: false,
  user: { id: 42, login: "contributor", type: "User" },
  head: { sha: HEAD_SHA, ref: "feature/admission", repo: { full_name: REPOSITORY } },
  base: { ref: "main", repo: { full_name: REPOSITORY } },
};
const eligibleMaintenance = {
  ...eligibleMain,
  base: { ref: "maintenance/1.4.x", repo: { full_name: REPOSITORY } },
};

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

function successfulChecks() {
  return [
    check(CHECK_IDENTITIES.ci),
    check(CHECK_IDENTITIES.dco, { id: 2 }),
  ];
}

function actionsRun(overrides = {}) {
  return {
    id: 123,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function reviewCheck(overrides = {}) {
  return check(CHECK_IDENTITIES.review, { id: 3, ...overrides });
}

function reviewRun(overrides = {}) {
  return actionsRun({
    event: "dynamic",
    path: "dynamic/agents/copilot-pull-request-reviewer",
    ...overrides,
  });
}

test("defines the exact authenticated CI, DCO, and Copilot identities", () => {
  assert.deepEqual(Object.keys(CHECK_IDENTITIES), ["dco", "ci", "review"]);
  assert.deepEqual(CHECK_IDENTITIES.dco, { name: "DCO", appId: 1861, appSlug: "dco" });
  assert.deepEqual(CHECK_IDENTITIES.ci, {
    name: "ci",
    appId: 15368,
    appSlug: "github-actions",
  });
  assert.deepEqual(CHECK_IDENTITIES.review, {
    name: "copilot-pull-request-reviewer",
    appId: 15368,
    appSlug: "github-actions",
  });
});

test("classifies the complete closed sensitive path set and both rename sides", () => {
  const sensitivePaths = [
    ".github/actions/setup-ci/action.yml",
    ".github/codeql/security.yml",
    ".github/scripts/helper.mjs",
    ".github/workflows/ci.yml",
    "bin/lcm.ts",
    "installer/install.ts",
    "scripts/bootstrap-pnpm.mjs",
    "src/index.ts",
    "test/setup/runtime-home.ts",
    "test/postgresql/template-init.sh",
    "test/postgresql/cached-run-init.sh",
    "test/postgresql/init.sh",
    "test/postgresql/harness.ts",
    "test/postgresql/operational-fixture.ts",
    "test/postgresql/portable-fixture.ts",
    "test/e2e/harness.ts",
    ".agents/skills/tests/policy.test.mjs",
    ".agents/skills/example/scripts/check.mjs",
    "package.json",
    "pnpm-lock.yaml",
    ".npmrc",
    "pnpm-workspace.yaml",
    "vitest.postgresql.config.ts",
    "vitestcustom.config.mjs",
    "tsconfig.native-transcript-package.json",
    "tsconfigcustom.json",
    "codecov.yml",
    "install.sh",
    ".pnpmfile.cjs",
  ];
  for (const filename of sensitivePaths) {
    const result = classifyPullRequestFiles([{ filename, status: "modified" }], 1);
    assert.equal(result.sensitive, true, filename);
    assert.equal(result.classification, ADMISSION_CLASSIFICATIONS.sensitive, filename);
    assert.deepEqual(result.matchedPaths, [filename], filename);
  }

  for (const filename of [
    "test/example.test.ts",
    "test/postgresql/harness.test.ts",
    "test/postgresql/runtime.integration.ts",
    "test/postgresql/fixtures/coordination-crash-worker.mjs",
    ".agents/skills/example/SKILL.md",
    "eslint.config.js",
    ".github/renovate.json",
    "docs/external-admission.md",
  ]) {
    const result = classifyPullRequestFiles([{ filename, status: "modified" }], 1);
    assert.equal(result.sensitive, false, filename);
    assert.equal(result.classification, ADMISSION_CLASSIFICATIONS.nonSensitive, filename);
  }

  const renamed = classifyPullRequestFiles([{
    filename: "docs/old-ci.md",
    previous_filename: ".github/workflows/ci.yml",
    status: "renamed",
  }], 1);
  assert.equal(renamed.sensitive, true);
  assert.deepEqual(renamed.auditedPaths, ["docs/old-ci.md", ".github/workflows/ci.yml"]);
});

test("rejects incomplete, duplicate, over-cap, and malformed PR file records", () => {
  assert.deepEqual(flattenPullRequestFilePages([[{ filename: "a", status: "added" }], []]), [
    { filename: "a", status: "added" },
  ]);
  assert.throws(() => flattenPullRequestFilePages({}), /must be an array/u);
  assert.throws(() => flattenPullRequestFilePages([{}]), /page 0 must be an array/u);

  for (const count of [0, -1, 3001, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
    assert.throws(() => classifyPullRequestFiles([], count), /changed_files/u, String(count));
  }
  assert.throws(
    () => classifyPullRequestFiles([{ filename: "a", status: "added" }], 2),
    /does not match changed_files/u,
  );
  assert.throws(
    () => classifyPullRequestFiles([
      { filename: "a", status: "added" },
      { filename: "a", status: "modified" },
    ], 2),
    /duplicate destination/u,
  );
  for (const file of [
    null,
    { filename: "", status: "added" },
    { filename: "a", status: "" },
    { filename: "a", status: "renamed" },
    { filename: "a", status: "copied", previous_filename: null },
    { filename: "a", status: "modified", previous_filename: "old" },
    { filename: "a", status: "renamed", previous_filename: "" },
    { filename: "a", status: "invented" },
  ]) {
    assert.throws(() => classifyPullRequestFiles([file], 1), /pull request file/u);
  }
});

test("binds PR file evidence to the exact head and changed-file count", () => {
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-file-binding",
    [HEAD_SHA, "1"],
    JSON.stringify(eligibleMain),
  )), { ready: true });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-file-binding",
    [HEAD_SHA, "1"],
    JSON.stringify({ ...eligibleMain, head: { ...eligibleMain.head, sha: "b".repeat(40) } }),
  )), { ready: false, pending: true, reason: "pr-file-snapshot-changed" });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-file-binding",
    [HEAD_SHA, "1"],
    JSON.stringify({ ...eligibleMain, changed_files: 2 }),
  )), { ready: false, pending: true, reason: "pr-file-snapshot-changed" });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-file-binding",
    [HEAD_SHA, "1"],
    JSON.stringify({ ...eligibleMain, changed_files: "1" }),
  )), { ready: false, pending: false, terminalFailure: "pr-file-snapshot" });
});

test("authenticates only an exact successful Copilot dynamic check and run", () => {
  const evaluatedCheck = evaluateReviewCheck({
    checkRuns: [reviewCheck()],
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  });
  assert.deepEqual(evaluatedCheck, {
    state: "success",
    ready: true,
    pending: false,
    terminalFailure: undefined,
    checkRunId: "3",
    runId: "123",
  });
  assert.deepEqual(evaluateReviewActionsRun(reviewRun(), {
    runId: "123",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  }), { state: "success", ready: true, terminalFailure: undefined });

  for (const status of [undefined, "pending", "queued", "in_progress", "requested", "waiting"]) {
    const result = evaluateReviewCheck({
      checkRuns: [reviewCheck({ status, conclusion: null })],
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    });
    assert.equal(result.ready, false, String(status));
    assert.equal(result.pending, true, String(status));
    assert.equal(result.terminalFailure, undefined, String(status));
  }
  for (const conclusion of [
    "neutral", "skipped", "cancelled", "timed_out", "action_required", "failure",
    "stale", "startup_failure", "unknown-terminal",
  ]) {
    const result = evaluateReviewCheck({
      checkRuns: [reviewCheck({ conclusion })],
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    });
    assert.equal(result.ready, false, conclusion);
    assert.equal(result.pending, false, conclusion);
    assert.equal(result.terminalFailure, "review-run", conclusion);
  }
  assert.equal(evaluateReviewCheck({
    checkRuns: [reviewCheck({ details_url: "https://example.invalid/run/123" })],
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  }).terminalFailure, "review-run-url");

  for (const [field, value] of [
    ["event", "pull_request"],
    ["path", ".github/workflows/ci.yml"],
    ["path", "dynamic/github-code-quality/codeql"],
    ["head_sha", "c".repeat(40)],
    ["repository", { full_name: "other/repository" }],
  ]) {
    assert.deepEqual(evaluateReviewActionsRun(reviewRun({ [field]: value }), {
      runId: "123",
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), { state: "invalid", ready: false, terminalFailure: "review-run-metadata" }, field);
  }
});

test("requires exact Copilot dynamic-run evidence for every sensitive change", () => {
  const validReview = { ready: true, checkRunId: "3", runId: "123" };
  assert.deepEqual(evaluateSensitiveAdmission({
    sensitive: true,
    review: validReview,
  }), { ready: true, evidenceClass: "copilot", evidenceIds: ["3", "123"] });
  assert.deepEqual(evaluateSensitiveAdmission({
    sensitive: false,
    review: { ready: false, pending: true },
  }), { ready: true, evidenceClass: "ci-dco", evidenceIds: [] });
  assert.deepEqual(evaluateSensitiveAdmission({
    sensitive: true,
    review: { ready: false, pending: true },
  }), { ready: false, pending: true, terminalFailure: undefined });
  assert.deepEqual(evaluateSensitiveAdmission({
    sensitive: true,
    review: { ready: false, pending: false, terminalFailure: "review-run" },
  }), { ready: false, pending: false, terminalFailure: "trusted-automation" });
  assert.deepEqual(evaluateSensitiveAdmission({
    sensitive: true,
    review: { ready: false, pending: false, terminalFailure: "review-run-metadata" },
    dependabot: { ready: true, commitShas: ["b".repeat(40)] },
  }), { ready: false, pending: false, terminalFailure: "trusted-automation" });
});

test("admits only open exact-head PRs on protected repository bases", () => {
  assert.deepEqual(evaluatePullRequestEligibility({
    pullRequest: eligibleMain,
    headSha: HEAD_SHA,
    repository: REPOSITORY,
    baseProtected: true,
  }), { eligible: true });

  assert.deepEqual(evaluatePullRequestEligibility({
    pullRequest: eligibleMaintenance,
    headSha: HEAD_SHA,
    repository: REPOSITORY,
    baseProtected: true,
  }), { eligible: true });

  const rejectedCases = [
    ["maintenance/1.x", "unsupported-base", {
      ...eligibleMain,
      base: { ref: "maintenance/1.x", repo: { full_name: REPOSITORY } },
    }],
    ["maintenance/1.4", "unsupported-base", {
      ...eligibleMain,
      base: { ref: "maintenance/1.4", repo: { full_name: REPOSITORY } },
    }],
    ["maintenance/security", "unsupported-base", {
      ...eligibleMain,
      base: { ref: "maintenance/security", repo: { full_name: REPOSITORY } },
    }],
    ["release/1.4.x", "unsupported-base", {
      ...eligibleMain,
      base: { ref: "release/1.4.x", repo: { full_name: REPOSITORY } },
    }],
    ["unprotected maintenance branch", "unprotected-base", eligibleMaintenance, false],
    ["wrong base repository", "repository-mismatch", {
      ...eligibleMain,
      base: { ref: "main", repo: { full_name: "other/repository" } },
    }],
    ["wrong head SHA", "ineligible-pr", {
      ...eligibleMain,
      head: { sha: "b".repeat(40) },
    }],
    ["draft", "ineligible-pr", { ...eligibleMain, draft: true }],
    ["closed", "ineligible-pr", { ...eligibleMain, state: "closed" }],
    ["malformed input", "ineligible-pr", null],
  ];

  for (const [name, reason, pullRequest, baseProtected = true] of rejectedCases) {
    assert.deepEqual(evaluatePullRequestEligibility({
      pullRequest,
      headSha: HEAD_SHA,
      repository: REPOSITORY,
      baseProtected,
    }), { eligible: false, reason }, name);
  }
});

test("flattens every check-run page and rejects malformed pages", () => {
  assert.deepEqual(flattenCheckRunPages([
    { check_runs: [{ id: 1 }] },
    { check_runs: [{ id: 2 }, { id: 3 }] },
  ]), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.throws(() => flattenCheckRunPages({}), /must be an array/u);
  assert.throws(() => flattenCheckRunPages([null]), /page 0 must be an object/u);
  assert.throws(() => flattenCheckRunPages([[]]), /page 0 must be an object/u);
  assert.throws(() => flattenCheckRunPages([{}]), /check_runs must be an array/u);
});

test("requires exact authenticated CI and DCO checks for every admission", () => {
  const evaluation = evaluateAdmissionChecks({
    checkRuns: successfulChecks(),
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  });
  assert.deepEqual(evaluation.states, { ci: "success", dco: "success" });
  assert.deepEqual(evaluation.requiredNames, ["ci", "dco"]);
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.terminalFailure, undefined);
  assert.equal(evaluation.ciCheckRunId, "1");
  assert.equal(evaluation.dcoCheckRunId, "2");
  assert.equal(evaluation.ciRunId, "123");
});

test("ignores spoofed, wrong-head, and older authenticated check runs", () => {
  const evaluation = evaluateAdmissionChecks({
    checkRuns: [
      check(CHECK_IDENTITIES.ci, { id: 10, conclusion: "failure" }),
      check(CHECK_IDENTITIES.ci, { id: 11, head_sha: "b".repeat(40) }),
      check(CHECK_IDENTITIES.ci, { id: 12, app: { id: 999, slug: "github-actions" } }),
      check(CHECK_IDENTITIES.ci, { id: 13, app: { id: 15368, slug: "spoof" } }),
      check(CHECK_IDENTITIES.ci, { id: 14 }),
      check(CHECK_IDENTITIES.dco, { id: 15 }),
    ],
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  });
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.ciCheckRunId, "14");
  assert.equal(evaluation.dcoCheckRunId, "15");
  assert.equal(evaluation.ciRunId, "123");
});

test("distinguishes missing and transient checks from terminal failures", () => {
  for (const status of [undefined, "pending", "queued", "in_progress", "requested", "waiting"]) {
    const waiting = evaluateAdmissionChecks({
      checkRuns: [
        check(CHECK_IDENTITIES.ci, { status, conclusion: null }),
        check(CHECK_IDENTITIES.dco, { id: 2 }),
      ],
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    });
    assert.equal(waiting.ready, false, String(status));
    assert.equal(waiting.terminalFailure, undefined, String(status));
  }

  const failed = evaluateAdmissionChecks({
    checkRuns: [
      check(CHECK_IDENTITIES.ci, { conclusion: "failure" }),
      check(CHECK_IDENTITIES.dco, { id: 2 }),
    ],
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.terminalFailure, "ci");

  const missingConclusion = evaluateAdmissionChecks({
    checkRuns: [
      check(CHECK_IDENTITIES.ci, { conclusion: null }),
      check(CHECK_IDENTITIES.dco, { id: 2 }),
    ],
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  });
  assert.equal(missingConclusion.ready, false);
  assert.equal(missingConclusion.terminalFailure, undefined);
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
      repository: REPOSITORY,
    });
    assert.equal(evaluation.ready, false, String(detailsUrl));
    assert.equal(evaluation.terminalFailure, "ci-run-url", String(detailsUrl));
  }
});

test("parses only same-origin repository Actions run URLs", () => {
  assert.equal(parseActionsRunId(
    `https://github.com/${REPOSITORY}/actions/runs/987654/job/123`,
    { repository: REPOSITORY },
  ), "987654");
  assert.equal(parseActionsRunId(
    `https://github.com/${REPOSITORY}/actions/runs/99999999999999999999/job/123`,
    { repository: REPOSITORY },
  ), "99999999999999999999");
  assert.equal(parseActionsRunId(
    `https://github.com/${REPOSITORY}/actions/runs/0`,
    { repository: REPOSITORY },
  ), undefined);
  assert.equal(parseActionsRunId("", { repository: REPOSITORY }), undefined);
  assert.throws(() => parseActionsRunId("https://github.com", {
    repository: "",
  }), /repository/u);
  assert.throws(() => parseActionsRunId("https://github.com", {
    repository: REPOSITORY,
    serverUrl: "",
  }), /server URL/u);
});

test("rejects unsafe or non-positive authenticated check IDs", () => {
  for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1, "0", "1.5", undefined]) {
    assert.throws(() => evaluateAdmissionChecks({
      checkRuns: [check(CHECK_IDENTITIES.ci, { id })],
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), /check run ID/u, String(id));
  }
  assert.throws(() => evaluateAdmissionChecks({
    checkRuns: successfulChecks(),
    headSha: "",
    repository: REPOSITORY,
  }), /head SHA/u);
});

test("waits for every documented transient CI Actions run state", () => {
  for (const status of ["queued", "in_progress", "pending", "requested", "waiting"]) {
    assert.deepEqual(evaluateCiActionsRun(actionsRun({ status, conclusion: null }), {
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

test("accepts only terminal CI success and rejects terminal non-success", () => {
  assert.deepEqual(evaluateCiActionsRun(actionsRun(), {
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
    assert.deepEqual(evaluateCiActionsRun(actionsRun({ conclusion }), {
      runId: "123",
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), { state: conclusion, ready: false, terminalFailure: "ci-run" }, conclusion);
  }
  assert.deepEqual(evaluateCiActionsRun(actionsRun({ conclusion: null }), {
    runId: "123",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  }), { state: "missing", ready: false, terminalFailure: "ci-run" });
});

test("enforces arbitrary-precision freshness lower bounds for trusted events", () => {
  const hugeVisibleId = "9007199254740992";
  const hugeEventId = "9007199254740993";
  const cases = [
    [
      "older CI requested event is superseded by newer visible evidence",
      {
        eventSource: "workflow_run",
        workflowRunAction: "requested",
        workflowRunId: "99",
        ciRunId: "100",
      },
      { ready: true },
    ],
    [
      "equal completed CI event can reconcile current evidence",
      {
        eventSource: "workflow_run",
        workflowRunAction: "completed",
        workflowRunId: "100",
        ciRunId: "100",
      },
      { ready: true },
    ],
    [
      "equal requested CI event remains pending",
      {
        eventSource: "workflow_run",
        workflowRunAction: "requested",
        workflowRunId: "100",
        ciRunId: "100",
      },
      { ready: false, pending: true, reason: "event-freshness" },
    ],
    [
      "equal in-progress CI event remains pending",
      {
        eventSource: "workflow_run",
        workflowRunAction: "in_progress",
        workflowRunId: "100",
        ciRunId: "100",
      },
      { ready: false, pending: true, reason: "event-freshness" },
    ],
    [
      "newer CI event remains pending until its run is visible",
      {
        eventSource: "workflow_run",
        workflowRunAction: "completed",
        workflowRunId: hugeEventId,
        ciRunId: hugeVisibleId,
      },
      { ready: false, pending: true, reason: "event-freshness" },
    ],
    [
      "older DCO created event is superseded by newer visible evidence",
      {
        eventSource: "check_run",
        checkRunAction: "created",
        checkRunId: "99",
        dcoCheckRunId: "100",
      },
      { ready: true },
    ],
    [
      "equal DCO created event remains pending",
      {
        eventSource: "check_run",
        checkRunAction: "created",
        checkRunId: "100",
        dcoCheckRunId: "100",
      },
      { ready: false, pending: true, reason: "event-freshness" },
    ],
    [
      "equal DCO rerequested event remains pending",
      {
        eventSource: "check_run",
        checkRunAction: "rerequested",
        checkRunId: "100",
        dcoCheckRunId: "100",
      },
      { ready: false, pending: true, reason: "event-freshness" },
    ],
    [
      "equal completed DCO event can reconcile current evidence",
      {
        eventSource: "check_run",
        checkRunAction: "completed",
        checkRunId: "100",
        dcoCheckRunId: "100",
      },
      { ready: true },
    ],
    [
      "newer DCO event remains pending until its check is visible",
      {
        eventSource: "check_run",
        checkRunAction: "completed",
        checkRunId: hugeEventId,
        dcoCheckRunId: hugeVisibleId,
      },
      { ready: false, pending: true, reason: "event-freshness" },
    ],
    [
      "recovery dispatch has no event freshness lower bound",
      { eventSource: "repository_dispatch" },
      { ready: true },
    ],
  ];

  for (const [name, input, expected] of cases) {
    assert.deepEqual(evaluateEventFreshness(input), expected, name);
  }
});

test("fails closed for malformed or unauthenticated freshness metadata", () => {
  const malformedCases = [
    { eventSource: "workflow_run", workflowRunAction: "completed", workflowRunId: "0", ciRunId: "1" },
    { eventSource: "workflow_run", workflowRunAction: "unknown", workflowRunId: "1", ciRunId: "1" },
    { eventSource: "check_run", checkRunAction: "completed", checkRunId: "not-an-id", dcoCheckRunId: "1" },
    { eventSource: "check_run", checkRunAction: "unknown", checkRunId: "1", dcoCheckRunId: "1" },
    { eventSource: "unexpected", workflowRunAction: "completed", workflowRunId: "1", ciRunId: "1" },
  ];

  for (const input of malformedCases) {
    assert.deepEqual(evaluateEventFreshness(input), {
      ready: false,
      terminalFailure: "event-freshness",
    }, JSON.stringify(input));
  }

  assert.deepEqual(evaluateEventFreshness({
    eventSource: "workflow_run",
    workflowRunAction: "completed",
    workflowRunId: "1",
  }), { ready: false, pending: true, reason: "event-freshness" });
});

test("honors an explicit canonical CI workflow path override", () => {
  assert.deepEqual(evaluateCiActionsRun(actionsRun({ path: ".github/workflows/trusted-ci.yml" }), {
    runId: "123",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
    workflowPath: ".github/workflows/trusted-ci.yml",
  }), { state: "success", ready: true, terminalFailure: undefined });
});

test("rejects malformed CI states and every Actions provenance mismatch", () => {
  for (const status of [undefined, null, "unknown"]) {
    assert.deepEqual(evaluateCiActionsRun(actionsRun({ status }), {
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
    assert.deepEqual(evaluateCiActionsRun(actionsRun({ [field]: value }), {
      runId: 123,
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), { state: "invalid", ready: false, terminalFailure: "ci-run-metadata" }, field);
  }
  for (const run of [null, [], actionsRun({ id: "bad" })]) {
    assert.deepEqual(evaluateCiActionsRun(run, {
      runId: "123",
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), { state: "invalid", ready: false, terminalFailure: "ci-run-metadata" });
  }
});

test("exposes the complete policy through deterministic CLI commands", () => {
  const evaluation = JSON.parse(runPolicyCommand("evaluate-checks", [
    HEAD_SHA,
    REPOSITORY,
    "https://github.com",
  ], JSON.stringify([{ check_runs: successfulChecks() }])));
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.ciCheckRunId, "1");
  assert.equal(evaluation.dcoCheckRunId, "2");
  assert.equal(evaluation.ciRunId, "123");

  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-ci-run",
    ["123", HEAD_SHA, REPOSITORY],
    JSON.stringify(actionsRun()),
  )), { state: "success", ready: true });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-ci-run",
    ["0", HEAD_SHA, REPOSITORY],
    JSON.stringify(actionsRun()),
  )), { state: "invalid", ready: false, terminalFailure: "ci-run-metadata" });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-pr",
    [HEAD_SHA, REPOSITORY, "true"],
    JSON.stringify(eligibleMain),
  )), { eligible: true });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-pr",
    [HEAD_SHA, REPOSITORY, "false"],
    JSON.stringify(eligibleMaintenance),
  )), { eligible: false, reason: "unprotected-base" });
  assert.deepEqual(JSON.parse(runPolicyCommand(
    "evaluate-freshness",
    ["workflow_run", "completed", "100", "", "", "100", ""],
    "{}",
  )), { ready: true });

  assert.throws(() => runPolicyCommand("unknown", [], "{}"), /unknown policy command/u);
  assert.throws(() => runPolicyCommand("evaluate-checks", [], "{}"), /unknown policy command/u);
  assert.throws(() => runPolicyCommand(
    "evaluate-dependabot-pr", [HEAD_SHA, REPOSITORY], JSON.stringify(eligibleMain),
  ), /unknown policy command/u);
  assert.throws(() => runPolicyCommand(
    "evaluate-dependabot-commits", ["1"], "[]",
  ), /unknown policy command/u);
  assert.throws(() => runPolicyCommand(
    "evaluate-ci-run", ["123", HEAD_SHA], "{}",
  ), /unknown policy command/u);
  assert.throws(() => runPolicyCommand(
    "evaluate-ci-run", ["123", HEAD_SHA, REPOSITORY, "extra"], "{}",
  ), /unknown policy command/u);
  assert.throws(() => runPolicyCommand("evaluate-checks", [
    HEAD_SHA,
    REPOSITORY,
    "https://github.com",
  ], ""), /non-empty/u);
  assert.throws(() => runPolicyCommand("evaluate-checks", {}, "{}"), /arguments/u);
});
