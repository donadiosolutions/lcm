import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_IDENTITIES,
  evaluateAdmissionChecks,
  evaluateCiActionsRun,
  flattenCheckRunPages,
  parseActionsRunId,
  runPolicyCommand,
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

test("defines only the authenticated CI and DCO identities", () => {
  assert.deepEqual(Object.keys(CHECK_IDENTITIES), ["dco", "ci"]);
  assert.deepEqual(CHECK_IDENTITIES.dco, { name: "DCO", appId: 1861, appSlug: "dco" });
  assert.deepEqual(CHECK_IDENTITIES.ci, {
    name: "ci",
    appId: 15368,
    appSlug: "github-actions",
  });
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

  assert.throws(() => runPolicyCommand("unknown", [], "{}"), /unknown policy command/u);
  assert.throws(() => runPolicyCommand("evaluate-checks", [], "{}"), /unknown policy command/u);
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
