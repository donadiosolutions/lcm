import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_IDENTITIES,
  CONTROL_CONTEXT,
  REVOCATION_CONTEXT,
  evaluateAdmissionChecks,
  evaluateAuthoredControls,
  evaluateControlStatuses,
  evaluateCiActionsRun,
  evaluateEventFreshness,
  evaluatePullRequestEligibility,
  flattenCheckRunPages,
  parseActionsRunId,
  parseOperation,
  projectControlTree,
  runPolicyCommand,
  validatePullRequestSelector,
} from "./external-admission-policy.mjs";

const HEAD_SHA = "a".repeat(40);
const REPOSITORY = "donadiosolutions/lcm";
const BASE_SHA = "b".repeat(40);
const ANCESTOR_SHA = "c".repeat(40);
const TREE_SHA = "d".repeat(40);
const OTHER_TREE_SHA = "e".repeat(40);

function tree(files, sha = TREE_SHA) {
  const entries = new Map();
  for (const [path, object = "1".repeat(40), mode = "100644", type = "blob"] of files) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join("/");
      entries.set(ancestor, { path: ancestor, sha: "2".repeat(40), mode: "040000", type: "tree" });
    }
    entries.set(path, { path, sha: object, mode, type });
  }
  return { sha, truncated: false, tree: [...entries.values()] };
}

function controls(before, after, overrides = {}) {
  return evaluateAuthoredControls({
    repository: REPOSITORY, prNumber: 123, headSha: HEAD_SHA, baseRef: "main", baseSha: BASE_SHA,
    compare: { base_commit: { sha: BASE_SHA }, head_commit: { sha: HEAD_SHA }, merge_base_commit: { sha: ANCESTOR_SHA } },
    ancestorCommit: { sha: ANCESTOR_SHA, tree: { sha: TREE_SHA } },
    headCommit: { sha: HEAD_SHA, tree: { sha: OTHER_TREE_SHA } },
    ancestorTree: tree(before), headTree: tree(after, OTHER_TREE_SHA), ...overrides,
  });
}

function controlStatus(id, overrides = {}) {
  return { id, context: CONTROL_CONTEXT, state: "success", creator: { id: 41898282, login: "github-actions[bot]" },
    target_url: `https://github.com/${REPOSITORY}/actions/runs/42`,
    url: `https://api.github.com/repos/${REPOSITORY}/statuses/${HEAD_SHA}`,
    description: `controls-v1:${"f".repeat(64)}`, ...overrides };
}

function statusDecision(statuses, overrides = {}) {
  return evaluateControlStatuses({ pages: [statuses], repository: REPOSITORY, headSha: HEAD_SHA,
    changed: true, digest: "f".repeat(64), ...overrides });
}

test("authored immutable controls require authorization even when a mutable merge would look unchanged", () => {
  const old = "1".repeat(40);
  const next = "3".repeat(40);
  for (const path of [".github/workflows/ci.yml", ".github/actions/local/action.yml", "scripts/ci-plan.mjs",
    ".agents/skills/helper.py", "test/setup/mock.ts", "test/postgresql/init.sh",
    "test/postgresql/cached-run-init.sh", "test/postgresql/template-init.sh", "test/surface-parity/surface-matrix.json",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".gitattributes", ".gitmodules",
    ".gitignore", ".npmignore", "vitest.config.ts", "tsconfig.json", "new-tool.toml", ".env.test", ".node-version", "new-tool.cfg", "unittest.py",
    "pathlib.pyc", "re.cpython-314-x86_64-linux-gnu.so", "unittest/__init__.py", "unittest/__main__.py",
    "pathlib/__init__.py", "new_package/__init__.py", "bytecode/__init__.pyc", "native/__init__.so",
    "native/__init__.cpython-314-x86_64-linux-gnu.so"]) {
    assert.equal(controls([[path, old]], [[path, next]]).changed, true, path);
    assert.equal(controls([], [[path, old]]).changed, true, `added ${path}`);
    assert.equal(controls([[path, old]], []).changed, true, `removed ${path}`);
  }
  assert.equal(controls([["tool", old, "100755"]], [["tool", next, "100755"]]).changed, true);
  const authored = controls([["package.json", old]], [["package.json", next]]);
  assert.equal(authored.changed, true);
  // Moving B to a tree that already contains the authored edit changes neither A nor the receipt digest.
  const moved = controls([["package.json", old]], [["package.json", next]], {
    baseSha: "9".repeat(40), compare: { base_commit: { sha: "9".repeat(40) },
      head_commit: { sha: HEAD_SHA }, merge_base_commit: { sha: ANCESTOR_SHA } },
  });
  assert.equal(moved.digest, authored.digest);
});

test("ordinary assertions, production and docs remain automatic despite partial-ancestor SHA changes", () => {
  for (const path of ["src/tool.ts", "test/tool.test.ts", "test/postgresql/assertion.test.ts",
    "test/surface-parity/assertion.test.ts", "docs/cli.md", ".agents/README.md",
    "docs/examples/demo.py", "test/fixtures/helper.py", "src/examples/demo.py",
    "bin/examples/demo.py", "installer/fixtures/helper.py", "test/fixtures/__init__.py",
    "docs/examples/__main__.py", "docs/examples/native.so", "test/fixtures/helper.pyc"]) {
    const before = tree([[path, "1".repeat(40)]]);
    const after = tree([[path, "3".repeat(40)]], OTHER_TREE_SHA);
    for (const entry of after.tree.filter((entry) => entry.type === "tree")) entry.sha = "4".repeat(40);
    assert.equal(controls([], [], { ancestorTree: before, headTree: after }).changed, false, path);
  }
  assert.equal(statusDecision([], { changed: false }).ready, true);
  assert.equal(controls([["unittest/__init__.py"], ["unittest/data.txt", "1".repeat(40)]],
    [["unittest/__init__.py"], ["unittest/data.txt", "3".repeat(40)]]).changed, true);
  assert.equal(controls([["pathlib/__init__.py"], ["pathlib/nested/helper.py", "1".repeat(40)]],
    [["pathlib/__init__.py"], ["pathlib/nested/helper.py", "3".repeat(40)]]).changed, true);
});

test("projection/digest is deterministic and binds PR, head, ancestor, base ref, modes and renamed controls", () => {
  const entries = [["package.json"], ["scripts/run.sh"]];
  const original = controls(entries, entries);
  assert.equal(original.digest, controls(entries.toReversed(), entries.toReversed()).digest);
  assert.notEqual(original.digest, controls(entries, entries, { prNumber: 124 }).digest);
  assert.notEqual(original.digest, controls(entries, entries, { baseRef: "maintenance/1.4.x" }).digest);
  assert.notEqual(original.digest, controls(entries, entries, { headSha: BASE_SHA,
    headCommit: { sha: BASE_SHA, tree: { sha: OTHER_TREE_SHA } },
    compare: { base_commit: { sha: BASE_SHA }, head_commit: { sha: BASE_SHA }, merge_base_commit: { sha: ANCESTOR_SHA } } }).digest);
  const noHeadEcho = { base_commit: { sha: BASE_SHA }, merge_base_commit: { sha: ANCESTOR_SHA } };
  assert.equal(controls(entries, entries, { compare: noHeadEcho }).digest, original.digest);
  assert.equal(controls([["scripts/a.sh"]], [["scripts/b.sh"]]).changed, true);
  assert.equal(controls([["package.json"]], [["package.json", "1".repeat(40), "100755"]]).changed, true);
  assert.throws(() => controls([], [], { compare: { base_commit: { sha: BASE_SHA },
    head_commit: { sha: "9".repeat(40) }, merge_base_commit: { sha: ANCESTOR_SHA } } }), /compare identity/u);
  assert.throws(() => controls([], [], { headCommit: { sha: BASE_SHA } }), /commit identity/u);
  assert.throws(() => controls([], [], { ancestorTree: { ...tree([]), truncated: true } }), /truncated/u);
});

test("rejects malformed paths, aliases, duplicates, hierarchy, modes, object identities and unsafe ancestors", () => {
  for (const path of ["/package.json", "./package.json", "a//b", "a/../b", "a\\b", "a\u0000b"]) {
    assert.throws(() => projectControlTree(tree([[path]]), TREE_SHA), /path|hierarchy/u, path);
  }
  const duplicate = tree([["package.json"]]);
  duplicate.tree.push(duplicate.tree[0]);
  assert.throws(() => projectControlTree(duplicate, TREE_SHA), /duplicate/u);
  for (const [mode, type] of [["100644", "tree"], ["040000", "blob"], ["777777", "blob"]]) {
    assert.throws(() => projectControlTree(tree([["package.json", "1".repeat(40), mode, type]]), TREE_SHA), /mode\/type/u);
  }
  assert.throws(() => projectControlTree(tree([["package.json", "bad"]]), TREE_SHA), /SHA/u);
  const missingAncestor = tree([["test/setup/file.ts"]]);
  missingAncestor.tree = missingAncestor.tree.filter((entry) => entry.path !== "test");
  assert.throws(() => projectControlTree(missingAncestor, TREE_SHA), /hierarchy/u);
  assert.throws(() => projectControlTree(tree([["test", "1".repeat(40), "120000"]]), TREE_SHA), /unsafe control ancestor/u);
  assert.throws(() => controls([["unittest/__init__.py"]], [["unittest", "1".repeat(40), "120000"]]), /unsafe Python/u);
});

test("only authenticated dispatch sender can select authorize/revoke, and recovery never authorizes", () => {
  assert.deepEqual(parseOperation({ eventSource: "repository_dispatch", action: "external-admission-reconcile" }), { operation: "reconcile" });
  for (const operation of ["authorize", "revoke"]) {
    const input = { eventSource: "repository_dispatch", action: `external-admission-control-${operation}`,
      senderId: "1458878", prNumber: "123", digest: "f".repeat(64) };
    assert.equal(parseOperation(input).operation, operation);
    assert.throws(() => parseOperation({ ...input, senderId: "42" }), /untrusted/u);
    assert.throws(() => parseOperation({ ...input, prNumber: "01" }), /positive/u);
  }
  assert.throws(() => parseOperation({ eventSource: "repository_dispatch", action: "external-admission-control-authorize",
    senderId: "1458878", prNumber: 123, digest: "bad" }), /digest/u);
  const closed = { number: 123, state: "closed", head: { sha: HEAD_SHA }, base: { repo: { full_name: REPOSITORY } } };
  assert.equal(validatePullRequestSelector({ pullRequest: closed, prNumber: 123, headSha: HEAD_SHA, repository: REPOSITORY }).valid, true);
  assert.throws(() => validatePullRequestSelector({ pullRequest: closed, prNumber: 124, headSha: HEAD_SHA, repository: REPOSITORY }), /selector/u);
});

test("sticky authorization requires exact trusted identity, head, digest and run URL; latest invalid receipt wins", () => {
  assert.equal(statusDecision([controlStatus(1)]).ready, true);
  for (const overrides of [{ creator: { id: 42, login: "github-actions[bot]" } }, { state: "failure" },
    { context: "other" }, { description: `controls-v1:${"e".repeat(64)}` },
    { url: `https://api.github.com/repos/${REPOSITORY}/statuses/${BASE_SHA}` },
    { target_url: `https://github.com/other/repository/actions/runs/42` },
    { target_url: `https://github.com/${REPOSITORY}/actions/runs/42?spoof=yes` }]) {
    assert.equal(statusDecision([controlStatus(2, overrides), controlStatus(1)]).ready,
      overrides.context === "other", JSON.stringify(overrides));
  }
  assert.equal(statusDecision([controlStatus(1)], { headSha: BASE_SHA }).ready, false);
  const pages = [Array.from({ length: 100 }, (_, index) => controlStatus(100 - index)), []];
  assert.equal(statusDecision([], { pages }).ready, true);
  assert.throws(() => statusDecision([], { pages: [pages[0]] }), /incomplete/u);
  assert.throws(() => statusDecision([], { pages: [[], []] }), /incomplete/u);
  assert.throws(() => statusDecision([controlStatus(1), controlStatus(1)]), /duplicate/u);
  assert.throws(() => statusDecision([null]), /malformed/u);
});

test("permanent head-global tombstones dominate all later authorization, changed or unchanged projections and recovery", () => {
  const tombstone = controlStatus(1, { context: REVOCATION_CONTEXT, state: "failure", description: "controls-v1:revoked" });
  for (const changed of [true, false]) {
    for (const digest of ["e".repeat(64), "f".repeat(64)]) {
      const result = statusDecision([controlStatus(3, { description: `controls-v1:${digest}` }), tombstone], { changed, digest });
      assert.equal(result.revoked, true);
      assert.equal(result.ready, false);
    }
  }
  const readback = statusDecision([controlStatus(4, { context: "external-admission", state: "failure" }), tombstone]);
  assert.equal(readback.admissionFailed, true);
  assert.equal(statusDecision([tombstone], { headSha: BASE_SHA, changed: false }).ready, true);
  assert.equal(statusDecision([controlStatus(2, { url: `https://api.github.com/repos/${REPOSITORY}/statuses/${BASE_SHA}` }), tombstone],
    { headSha: BASE_SHA }).ready, true);
  assert.equal(statusDecision([controlStatus(1, { ...tombstone, creator: { id: 42, login: "foreign-writer" } })], { changed: false }).revoked, false);
  assert.equal(statusDecision([controlStatus(1)]).ready, true);
  assert.equal(evaluateAdmissionChecks({ checkRuns: [check(CHECK_IDENTITIES.ci, { conclusion: "failure" }),
    check(CHECK_IDENTITIES.dco)], headSha: HEAD_SHA, repository: REPOSITORY }).ready, false);
});

test("rejects malformed relevant creator identities before trusting or ignoring control history", () => {
  const malformedCreators = [undefined, null, [], "github-actions[bot]", 41898282, true, {},
    { login: "github-actions[bot]" }, { id: null, login: "github-actions[bot]" },
    ...["41898282", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]
      .map((id) => ({ id, login: "github-actions[bot]" })),
    { id: 41898282 }, ...[null, "", 42, false, [], {}].map((login) => ({ id: 41898282, login }))];
  for (const context of [CONTROL_CONTEXT, REVOCATION_CONTEXT]) {
    for (const creator of malformedCreators) {
      const malformed = controlStatus(2, { context, state: "failure", creator });
      if (creator === undefined) delete malformed.creator;
      assert.throws(() => statusDecision([malformed], { changed: false }), /malformed relevant status creator/u);
      assert.throws(() => statusDecision([malformed, controlStatus(1)], { changed: true }), /malformed relevant status creator/u);
    }
  }
});

test("keeps well-formed foreign identities and nullable provenance untrusted without treating them as malformed", () => {
  for (const context of [CONTROL_CONTEXT, REVOCATION_CONTEXT]) {
    for (const overrides of [{ creator: { id: 42, login: "foreign-writer" } },
      { target_url: null }, { target_url: undefined },
      { url: `https://api.github.com/repos/${REPOSITORY}/statuses/${BASE_SHA}` },
      { url: `https://api.github.com/repos/other/repository/statuses/${HEAD_SHA}` }]) {
      const untrusted = controlStatus(2, { context, state: context === REVOCATION_CONTEXT ? "failure" : "success", ...overrides });
      const ordinary = statusDecision([untrusted], { changed: false });
      assert.equal(ordinary.revoked, false);
      assert.equal(ordinary.ready, true);
      const changed = statusDecision([untrusted, controlStatus(1)], { changed: true });
      assert.equal(changed.revoked, false);
      assert.equal(changed.ready, context === REVOCATION_CONTEXT);
    }
  }
  assert.equal(statusDecision([controlStatus(1, { context: "unrelated", creator: undefined })], { changed: false }).ready, true);
});

test("policy command transport binds immutable snapshot records without command-line tree payloads", () => {
  const identity = { repository: REPOSITORY, prNumber: 123, headSha: HEAD_SHA, baseRef: "main", baseSha: BASE_SHA };
  const values = [identity, { base_commit: { sha: BASE_SHA }, merge_base_commit: { sha: ANCESTOR_SHA } },
    { sha: ANCESTOR_SHA, tree: { sha: TREE_SHA } }, { sha: HEAD_SHA, tree: { sha: OTHER_TREE_SHA } },
    tree([]), tree([["package.json"]], OTHER_TREE_SHA)];
  const output = runPolicyCommand("evaluate-control-snapshot", [], values.map((value) => JSON.stringify(value)).join("\n"));
  assert.equal(JSON.parse(output).changed, true);
  assert.throws(() => runPolicyCommand("evaluate-control-snapshot", [], "{}\n{}"), /incomplete/u);
  assert.equal(JSON.parse(runPolicyCommand("parse-operation", [], JSON.stringify({ eventSource: "repository_dispatch",
    action: "external-admission-reconcile" }))).operation, "reconcile");
  assert.equal(JSON.parse(runPolicyCommand("evaluate-control-statuses", [], JSON.stringify({ repository: REPOSITORY,
    headSha: HEAD_SHA, pages: [[]], changed: false }))).ready, true);
});
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

test("defines only the exact authenticated CI and DCO identities", () => {
  assert.deepEqual(Object.keys(CHECK_IDENTITIES), ["dco", "ci"]);
  assert.deepEqual(CHECK_IDENTITIES.dco, { name: "DCO", appId: 1861, appSlug: "dco" });
  assert.deepEqual(CHECK_IDENTITIES.ci, {
    name: "ci",
    appId: 15368,
    appSlug: "github-actions",
  });
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
        workflowRunPath: ".github/workflows/ci.yml",
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
        workflowRunPath: ".github/workflows/ci.yml",
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
        workflowRunPath: ".github/workflows/ci.yml",
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
        workflowRunPath: ".github/workflows/ci.yml",
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
        workflowRunPath: ".github/workflows/ci.yml",
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
    { eventSource: "workflow_run", workflowRunAction: "completed", workflowRunId: "0", workflowRunPath: ".github/workflows/ci.yml", ciRunId: "1" },
    { eventSource: "workflow_run", workflowRunAction: "unknown", workflowRunId: "1", workflowRunPath: ".github/workflows/ci.yml", ciRunId: "1" },
    { eventSource: "workflow_run", workflowRunAction: "completed", workflowRunId: "1", workflowRunPath: ".github/workflows/copilot.yml", ciRunId: "1" },
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
    workflowRunPath: "dynamic/agents/copilot-pull-request-reviewer",
    ciRunId: "1",
  }), { ready: false, terminalFailure: "event-freshness" });
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
    ["workflow_run", "completed", "100", ".github/workflows/ci.yml", "", "", "100", ""],
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
  for (const command of [
    "classify-files",
    "evaluate-file-binding",
    "evaluate-review-check",
    "evaluate-review-run",
    "evaluate-sensitive-admission",
  ]) {
    assert.throws(() => runPolicyCommand(command, [], "{}"), /unknown policy command/u);
  }
  assert.throws(() => runPolicyCommand("evaluate-checks", [
    HEAD_SHA,
    REPOSITORY,
    "https://github.com",
  ], ""), /non-empty/u);
  assert.throws(() => runPolicyCommand("evaluate-checks", {}, "{}"), /arguments/u);
});
