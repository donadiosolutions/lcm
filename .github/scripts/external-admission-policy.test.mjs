import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMISSION_CLASSIFICATIONS,
  CHECK_IDENTITIES,
  classifyPullRequestFiles,
  evaluateAdmissionChecks,
  flattenCheckRunPages,
  flattenPullRequestFilePages,
  isTrustedCiActionsRun,
  parseActionsRunId,
  requiresCodecovForPath,
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

test("classifies every coverable and trust-sensitive path family", () => {
  for (const path of [
    "bin/lcm.ts",
    "bin/nested/tool.ts",
    "bin/ui.tsx",
    "installer/install.ts",
    "installer/loader.cts",
    "src/index.ts",
    "src/index.mts",
    "src/component.tsx",
    "src/storage/backend.ts",
    ".github/codeql/security-extended.yml",
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    ".github/scripts/external-admission-policy.mjs",
    "package.json",
    "package-lock.json",
    "vitest.config.ts",
    "vitest.unit.config.mts",
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    assert.equal(requiresCodecovForPath(path), true, path);
  }
});

test("keeps documentation, tests, and unrelated metadata coverage-neutral", () => {
  for (const path of [
    "README.md",
    "docs/configuration.md",
    "test/daemon/config.test.ts",
    ".changeset/example.md",
    ".github/copilot-instructions.md",
    "src/index.js",
    "src/index.jsx",
    "src/index.mjs",
    "src/index.cjs",
    "nested/src/index.ts",
  ]) {
    assert.equal(requiresCodecovForPath(path), false, path);
  }
});

test("audits both current and previous rename paths without duplicates", () => {
  assert.deepEqual(classifyPullRequestFiles([
    { filename: "docs/new.md", previous_filename: "src/old.ts" },
    { filename: "docs/new.md" },
  ], 2), {
    classification: ADMISSION_CLASSIFICATIONS.codecovRequired,
    codecovRequired: true,
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
    codecovRequired: false,
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
  assert.throws(() => requiresCodecovForPath(""), /non-empty string/u);
});

test("requires an exact safe authoritative changed-files count", () => {
  const cappedFileResponse = Array.from(
    { length: 3_000 },
    (_, index) => ({ filename: `docs/file-${index}.md` }),
  );
  assert.equal(classifyPullRequestFiles(cappedFileResponse, 3_000).codecovRequired, false);
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

test("requires exact authenticated Codecov and DCO checks for sensitive diffs", () => {
  const evaluation = evaluateAdmissionChecks({
    checkRuns: [check(CHECK_IDENTITIES.codecov), check(CHECK_IDENTITIES.dco, { id: 2 })],
    headSha: HEAD_SHA,
    codecovRequired: true,
    repository: REPOSITORY,
  });
  assert.deepEqual(evaluation.requiredNames, ["codecov", "dco"]);
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.ciRunId, undefined);
});

test("requires exact authenticated CI and DCO checks for neutral diffs", () => {
  const evaluation = evaluateAdmissionChecks({
    checkRuns: [check(CHECK_IDENTITIES.ci), check(CHECK_IDENTITIES.dco, { id: 2 })],
    headSha: HEAD_SHA,
    codecovRequired: false,
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
    codecovRequired: false,
    repository: REPOSITORY,
  });
  assert.equal(evaluation.ready, true);
});

test("distinguishes waiting checks from terminal failures", () => {
  const waiting = evaluateAdmissionChecks({
    checkRuns: [
      check(CHECK_IDENTITIES.codecov, { status: "in_progress", conclusion: null }),
      check(CHECK_IDENTITIES.dco, { id: 2 }),
    ],
    headSha: HEAD_SHA,
    codecovRequired: true,
    repository: REPOSITORY,
  });
  assert.equal(waiting.ready, false);
  assert.equal(waiting.terminalFailure, undefined);

  const failed = evaluateAdmissionChecks({
    checkRuns: [
      check(CHECK_IDENTITIES.codecov, { conclusion: "failure" }),
      check(CHECK_IDENTITIES.dco, { id: 2 }),
    ],
    headSha: HEAD_SHA,
    codecovRequired: true,
    repository: REPOSITORY,
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.terminalFailure, "codecov");
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
      codecovRequired: false,
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
      checkRuns: [check(CHECK_IDENTITIES.codecov, { id })],
      headSha: HEAD_SHA,
      codecovRequired: true,
      repository: REPOSITORY,
    }), /check run ID/u, String(id));
  }
});

test("validates every trusted CI Actions run metadata field", () => {
  const valid = {
    id: 123,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
  };
  assert.equal(isTrustedCiActionsRun(valid, {
    runId: "123",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  }), true);

  for (const [field, value] of [
    ["id", 124],
    ["event", "push"],
    ["path", ".github/workflows/other.yml"],
    ["head_sha", "b".repeat(40)],
    ["status", "in_progress"],
    ["conclusion", "failure"],
    ["repository", { full_name: "other/repo" }],
  ]) {
    assert.equal(isTrustedCiActionsRun({ ...valid, [field]: value }, {
      runId: 123,
      headSha: HEAD_SHA,
      repository: REPOSITORY,
    }), false, field);
  }
  assert.equal(isTrustedCiActionsRun(null, {
    runId: "123",
    headSha: HEAD_SHA,
    repository: REPOSITORY,
  }), false);
});

test("exposes the complete policy through its deterministic CLI command seam", () => {
  const classification = JSON.parse(runPolicyCommand("classify-files", ["1"], JSON.stringify([
    [{ filename: "docs/new.md", previous_filename: "src/old.ts" }],
  ])));
  assert.equal(classification.codecovRequired, true);

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

  const run = {
    id: 123,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
  };
  assert.equal(runPolicyCommand(
    "validate-ci-run",
    ["123", HEAD_SHA, REPOSITORY],
    JSON.stringify(run),
  ), "");
  assert.throws(() => runPolicyCommand(
    "validate-ci-run",
    ["0", HEAD_SHA, REPOSITORY],
    JSON.stringify(run),
  ), /not trusted/u);
  assert.throws(() => runPolicyCommand("evaluate-checks", [
    HEAD_SHA,
    "maybe",
    REPOSITORY,
    "https://github.com",
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
