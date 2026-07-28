import assert from "node:assert/strict";
import test from "node:test";
import { assertVerifiedReleaseTag } from "./release-tag-policy.mjs";
import {
  NPM_QUERY_TIMEOUT_MS,
  NPM_VERIFY_DELAYS_MS,
  RELEASE_DRAFT_MARKER,
  assertActionCreatedReleaseBody,
  assertNpmDistTags,
  assertReleaseCanAdvanceDistTag,
  associateCommitsWithPullRequests,
  buildHighlightsPrompt,
  categorizeReleasePullRequests,
  checkNpmReleaseState,
  classifyPullRequest,
  collectReleasePullRequests,
  compareReleaseVersions,
  parseChangesetDocument,
  parseHighlightsResult,
  parseReleaseTag,
  releaseDraftMarker,
  renderReleaseNotes,
  selectPreviousRelease,
  verifyNpmRelease,
} from "./release-policy.mjs";

const changeset = (bump, summary = "Ship the requested behavior.") =>
  `---\n"@donadiosolutions/lcm": ${bump}\n---\n\n${summary}\n`;

const pr = (number, labels = [], overrides = {}) => ({
  number,
  title: `Change ${number}`,
  html_url: `https://github.com/donadiosolutions/lcm/pull/${number}`,
  user: { login: `user${number}` },
  labels: labels.map((name) => ({ name })),
  head: { ref: `feature/${number}` },
  base: { ref: "main" },
  merged_at: `2026-07-${String(number).padStart(2, "0")}T00:00:00Z`,
  merge_commit_sha: String(number).repeat(40).slice(0, 40),
  ...overrides,
});

test("parses only canonical stable and beta tags", () => {
  assert.deepEqual(parseReleaseTag("v1.5.0-beta.2"), {
    tag: "v1.5.0-beta.2",
    version: "1.5.0-beta.2",
    major: 1,
    minor: 5,
    patch: 0,
    beta: 2,
    isBeta: true,
    series: "1.5",
  });
  assert.equal(parseReleaseTag("v1.5.0").isBeta, false);
  for (const tag of ["1.5.0", "v1.5.0-alpha.1", "v1.5.0-rc.1", "v1.5.0-beta.01", "v01.5.0", "v1.5.0+build"]) {
    assert.throws(() => parseReleaseTag(tag), /Unsupported release tag/u);
  }
  assert.throws(() => parseReleaseTag(`v${Number.MAX_SAFE_INTEGER + 1}.0.0`), /safe integer/u);
});

test("orders beta releases before their stable version", () => {
  assert.equal(compareReleaseVersions("1.5.0-beta.1", "1.5.0-beta.2"), -1);
  assert.equal(compareReleaseVersions("1.5.0-beta.2", "1.5.0"), -1);
  assert.equal(compareReleaseVersions("1.5.1-beta.0", "1.5.0"), 1);
  assert.equal(compareReleaseVersions("1.5.0", "1.5.0"), 0);
});

test("requires an annotated GitHub-verified release tag targeting the checkout", async () => {
  const tag = "v1.5.0-beta.2";
  const expectedCommit = "a".repeat(40);
  const tagSha = "b".repeat(40);
  const getRef = async () => ({
    data: { ref: `refs/tags/${tag}`, object: { type: "tag", sha: tagSha } },
  });
  const getTag = async () => ({
    data: {
      tag,
      object: { type: "commit", sha: expectedCommit },
      verification: { verified: true, reason: "valid" },
    },
  });
  const github = { rest: { git: { getRef, getTag } } };

  await assert.doesNotReject(() =>
    assertVerifiedReleaseTag({
      github,
      owner: "donadiosolutions",
      repo: "lcm",
      tag,
      expectedCommit,
    }),
  );
  await assert.rejects(
    () =>
      assertVerifiedReleaseTag({
        github: {
          rest: {
            git: {
              getRef: async () => ({
                data: { ref: `refs/tags/${tag}`, object: { type: "commit", sha: expectedCommit } },
              }),
              getTag,
            },
          },
        },
        owner: "donadiosolutions",
        repo: "lcm",
        tag,
        expectedCommit,
      }),
    /annotated tag object/u,
  );
  await assert.rejects(
    () =>
      assertVerifiedReleaseTag({
        github: {
          rest: {
            git: {
              getRef,
              getTag: async () => ({
                data: {
                  tag: "v1.5.0-beta.1",
                  object: { type: "commit", sha: expectedCommit },
                  verification: { verified: true, reason: "valid" },
                },
              }),
            },
          },
        },
        owner: "donadiosolutions",
        repo: "lcm",
        tag,
        expectedCommit,
      }),
    /tag identity/u,
  );
  await assert.rejects(
    () =>
      assertVerifiedReleaseTag({
        github: {
          rest: {
            git: {
              getRef,
              getTag: async () => ({
                data: {
                  tag,
                  object: { type: "commit", sha: "c".repeat(40) },
                  verification: { verified: true, reason: "valid" },
                },
              }),
            },
          },
        },
        owner: "donadiosolutions",
        repo: "lcm",
        tag,
        expectedCommit,
      }),
    /does not target checked-out commit/u,
  );
  await assert.rejects(
    () =>
      assertVerifiedReleaseTag({
        github: {
          rest: {
            git: {
              getRef,
              getTag: async () => ({
                data: {
                  tag,
                  object: { type: "commit", sha: expectedCommit },
                  verification: { verified: false, reason: "unsigned" },
                },
              }),
            },
          },
        },
        owner: "donadiosolutions",
        repo: "lcm",
        tag,
        expectedCommit,
      }),
    /GitHub-verified signature: unsigned/u,
  );
});

test("selects beta bases from the same major.minor series", () => {
  const releases = [
    { tag_name: "v1.5.0-beta.0", draft: false, published_at: "2026-07-02T00:00:00Z" },
    { tag_name: "v1.5.0", draft: true, published_at: null },
    { tag_name: "v1.4.1", draft: false, published_at: "2026-07-01T00:00:00Z" },
  ];
  assert.equal(
    selectPreviousRelease("v1.5.0-beta.1", releases, {
      ancestorTags: new Set(["v1.5.0-beta.0", "v1.4.1"]),
    }).tag_name,
    "v1.5.0-beta.0",
  );
});

test("falls back to the latest stable for the first beta in a series", () => {
  const releases = [
    { tag_name: "v1.4.1", draft: false, published_at: "2026-07-02T00:00:00Z" },
    { tag_name: "v1.4.0-beta.2", draft: false, published_at: "2026-07-01T00:00:00Z" },
  ];
  assert.equal(
    selectPreviousRelease("v1.5.0-beta.0", releases, {
      ancestorTags: new Set(releases.map(({ tag_name }) => tag_name)),
    }).tag_name,
    "v1.4.1",
  );
});

test("stable releases ignore intervening betas and use the last stable", () => {
  const releases = [
    { tag_name: "v1.5.0-beta.2", draft: false, published_at: "2026-07-03T00:00:00Z" },
    { tag_name: "v1.5.0-beta.1", draft: false, published_at: "2026-07-02T00:00:00Z" },
    { tag_name: "v1.4.1", draft: false, published_at: "2026-07-01T00:00:00Z" },
  ];
  assert.equal(
    selectPreviousRelease("v1.5.0", releases, {
      ancestorTags: new Set(releases.map(({ tag_name }) => tag_name)),
    }).tag_name,
    "v1.4.1",
  );
  assert.throws(
    () => selectPreviousRelease("v1.5.0", [], { ancestorTags: new Set() }),
    /No eligible published release/u,
  );
});

test("requires explicit ancestry information when selecting release bases", () => {
  const releases = [
    { tag_name: "v1.4.1", draft: false, published_at: "2026-07-01T00:00:00Z" },
  ];
  for (const options of [undefined, null, "invalid", []]) {
    assert.throws(
      () => selectPreviousRelease("v1.5.0", releases, options),
      {
        name: "TypeError",
        message: "Release selection options must be an object containing ancestorTags",
      },
    );
  }
  for (const options of [{}, { ancestorTags: [] }]) {
    assert.throws(
      () => selectPreviousRelease("v1.5.0", releases, options),
      { name: "TypeError", message: "ancestorTags must be a Set" },
    );
  }
});

test("parses changesets and detects invalid package bumps", () => {
  assert.deepEqual(parseChangesetDocument(changeset("major")), {
    bump: "major",
    summary: "Ship the requested behavior.",
  });
  assert.throws(() => parseChangesetDocument("missing"), /YAML frontmatter/u);
  assert.throws(() => parseChangesetDocument("---\n[]\n---\nsummary"), /package-to-bump/u);
  assert.throws(
    () =>
      parseChangesetDocument(
        '---\nbase: &b patch\n"@donadiosolutions/lcm": *b\n---\nAliased bump.\n',
      ),
    /Invalid changeset frontmatter/u,
  );
  assert.throws(() => parseChangesetDocument(changeset("alpha")), /Unsupported changeset bump/u);
  assert.throws(() => parseChangesetDocument(changeset("patch", "")), /must not be empty/u);
});

test("classifies major changesets and conventional PR titles", () => {
  assert.equal(classifyPullRequest(pr(1), [changeset("major")]), "breaking");
  assert.equal(
    classifyPullRequest(pr(2, [], { title: "feat(triage): add fields" })),
    "features",
  );
  assert.equal(
    classifyPullRequest(pr(3, [], { title: "fix: repair fields" })),
    "fixes",
  );
  assert.equal(
    classifyPullRequest(pr(7, [], { title: "feat!: replace API" })),
    "breaking",
  );
  assert.equal(
    classifyPullRequest(pr(9, [], { title: "refactor(storage)!: replace API" })),
    "breaking",
  );
  assert.equal(classifyPullRequest(pr(4)), "extra");
  assert.equal(classifyPullRequest(pr(5, ["no-release-notes"])), undefined);
  assert.equal(
    classifyPullRequest(pr(6, [], { head: { ref: "changeset-release/main" } })),
    undefined,
  );
  assert.equal(
    classifyPullRequest(
      pr(8, [], { head: { ref: "release/v1.5.0" }, title: "chore: release v1.5.0" }),
    ),
    undefined,
  );
  assert.equal(
    classifyPullRequest(
      pr(9, [], {
        head: { ref: "release/v1.5.0-beta.2" },
        title: "chore: release v1.5.0-beta.2",
      }),
    ),
    undefined,
  );
  assert.equal(
    classifyPullRequest(
      pr(10, [], { head: { ref: "release/v1.5.0" }, title: "chore: release v1.5.1" }),
    ),
    "extra",
  );
  assert.equal(
    classifyPullRequest(
      pr(11, [], {
        head: { ref: "release/v1.5.0-rc.1" },
        title: "chore: release v1.5.0-rc.1",
      }),
    ),
    "extra",
  );
});

test("categorizes and deduplicates PRs while preserving every included PR", () => {
  const categorized = categorizeReleasePullRequests([
    { pr: pr(3, [], { title: "fix: repair startup" }) },
    { pr: pr(2, [], { title: "feat: add mode" }) },
    { pr: pr(1), changesetContents: [changeset("major", "Break an API.")] },
    { pr: pr(2, [], { title: "feat: add mode" }) },
    { pr: pr(4) },
  ]);
  assert.deepEqual(categorized.breaking.map(({ number }) => number), [1]);
  assert.deepEqual(categorized.features.map(({ number }) => number), [2]);
  assert.deepEqual(categorized.fixes.map(({ number }) => number), [3]);
  assert.deepEqual(categorized.extra.map(({ number }) => number), [4]);
});

test("maps release commits to merged main PRs and rejects direct commits", () => {
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  const third = "c".repeat(40);
  const firstPr = pr(1, [], { merge_commit_sha: first });
  const secondPr = pr(2, [], { merge_commit_sha: second });
  const singleFallbackPr = pr(3, [], { merge_commit_sha: "d".repeat(40) });
  const associations = new Map([
    [first, [firstPr]],
    [second, [secondPr, firstPr]],
    [third, [singleFallbackPr]],
  ]);
  assert.deepEqual(
    associateCommitsWithPullRequests([first, second, third], associations).map(
      ({ number }) => number,
    ),
    [1, 2, 3],
  );
  assert.throws(
    () => associateCommitsWithPullRequests(["c".repeat(40)], new Map()),
    /no PR found/u,
  );
});

test("rejects ambiguous commit associations without an exact merge SHA match", () => {
  const commit = "e".repeat(40);
  const associations = new Map([
    [
      commit,
      [
        pr(12, [], { merge_commit_sha: "f".repeat(40) }),
        pr(34, [], { merge_commit_sha: "1".repeat(40) }),
      ],
    ],
  ]);

  assert.throws(
    () => associateCommitsWithPullRequests([commit], associations),
    (error) => {
      assert.match(error.message, new RegExp(commit, "u"));
      assert.match(error.message, /#12, #34/u);
      assert.match(error.message, /ambiguous merged main PR associations/u);
      return true;
    },
  );
});

test("paginates every commit-to-PR association lookup", async () => {
  const commit = "a".repeat(40);
  const associatedPullRequest = pr(1, [], { merge_commit_sha: commit });
  const associationEndpoint = () => {
    throw new Error("association endpoint must be called through github.paginate");
  };
  const filesEndpoint = () => {
    throw new Error("files endpoint must be called through github.paginate");
  };
  const paginateCalls = [];
  const github = {
    paginate: async (endpoint, parameters) => {
      paginateCalls.push({ endpoint, parameters });
      if (endpoint === associationEndpoint) return [associatedPullRequest];
      if (endpoint === filesEndpoint) return [];
      throw new Error("unexpected paginated endpoint");
    },
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: associationEndpoint,
      },
      pulls: {
        get: async () => ({ data: associatedPullRequest }),
        listFiles: filesEndpoint,
      },
    },
  };
  /** @type {Array<{ args: string[], cwd: string }>} */
  const gitCalls = [];
  /**
   * @param {string[]} args
   * @param {string} cwd
   * @returns {string}
   */
  const runGit = (args, cwd) => {
    gitCalls.push({ args, cwd });
    return commit;
  };

  const entries = await collectReleasePullRequests({
    github,
    owner: "donadiosolutions",
    repo: "lcm",
    baseTag: "v1.4.1",
    targetTag: "v1.5.0",
    cwd: "/workspace",
    runGit,
  });

  assert.deepEqual(entries, [{ pr: associatedPullRequest, changesetContents: [] }]);
  assert.deepEqual(gitCalls, [
    {
      args: ["rev-list", "--first-parent", "--reverse", "v1.4.1..v1.5.0"],
      cwd: "/workspace",
    },
  ]);
  assert.equal(paginateCalls[0].endpoint, associationEndpoint);
  assert.deepEqual(paginateCalls[0].parameters, {
    owner: "donadiosolutions",
    repo: "lcm",
    commit_sha: commit,
    per_page: 100,
  });
});

test("builds an injection-aware Highlights prompt and validates structured output", () => {
  const categorized = categorizeReleasePullRequests([
    {
      pr: pr(1, [], { title: "feat: add beta releases" }),
      changesetContents: [changeset("minor", "Add beta releases.")],
    },
  ]);
  const prompt = buildHighlightsPrompt({
    targetTag: "v1.5.0-beta.0",
    baseTag: "v1.4.1",
    categorized,
  });
  assert.match(prompt, /untrusted data/u);
  assert.match(prompt, /Add beta releases/u);
  assert.deepEqual(parseHighlightsResult('{"highlights":["- First", "Second"]}'), [
    "First",
    "Second",
  ]);
  assert.throws(() => parseHighlightsResult("not json"), /not valid JSON/u);
  assert.throws(() => parseHighlightsResult('{"highlights":[]}'), /between one and five/u);
  assert.throws(() => parseHighlightsResult('{"highlights":["ok"],"extra":true}'), /only a highlights array/u);
});

test("renders tag-bound Highlights and omits empty release sections", () => {
  const targetTag = "v1.5.0-beta.2";
  const categorized = categorizeReleasePullRequests([
    { pr: pr(1, [], { title: "feat: add [beta] support" }) },
    { pr: pr(2) },
  ]);
  const notes = renderReleaseNotes({
    targetTag,
    highlights: ["Beta releases are now available."],
    categorized,
  });
  assert.equal(releaseDraftMarker(targetTag), `${RELEASE_DRAFT_MARKER}${targetTag} -->`);
  assert.match(notes, new RegExp(releaseDraftMarker(targetTag)));
  assert.match(notes, /## Highlights/u);
  assert.doesNotMatch(notes, /## Breaking changes/u);
  assert.match(notes, /## Features/u);
  assert.doesNotMatch(notes, /## Fixes/u);
  assert.match(notes, /## Extra notes/u);
  assert.ok(notes.includes("feat: add \\[beta\\] support (#1)"));
  assertActionCreatedReleaseBody(notes, targetTag);
  assert.throws(() => assertActionCreatedReleaseBody(notes, "v1.5.0-beta.1"), /not created/u);
  assert.throws(
    () => assertActionCreatedReleaseBody("## Highlights\n\n- Missing marker", targetTag),
    /not created/u,
  );
  assert.throws(() => renderReleaseNotes({ targetTag, highlights: [], categorized }), /at least one/u);
});

test("queries npm release state with E404-only missing-package handling", () => {
  assert.equal(NPM_QUERY_TIMEOUT_MS, 60_000);
  /** @type {string[][]} */
  const calls = [];
  /** @type {Array<{ status: number, stdout: string, stderr: string }>} */
  const missingResults = [
    { status: 1, stdout: "", stderr: "npm error code E404" },
    { status: 1, stdout: "", stderr: "404 Not Found" },
  ];
  /**
   * @param {string[]} args
   * @returns {{ status: number, stdout: string, stderr: string }}
   */
  const missingNpm = (args) => {
    calls.push(args);
    return missingResults.shift();
  };
  assert.deepEqual(
    checkNpmReleaseState({ version: "1.5.0-beta.0", runNpm: missingNpm }),
    { alreadyPublished: false, distTags: {} },
  );
  assert.deepEqual(calls, [
    ["view", "@donadiosolutions/lcm@1.5.0-beta.0", "version"],
    ["view", "@donadiosolutions/lcm", "dist-tags", "--json"],
  ]);

  assert.throws(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    /empty response.*1\.5\.0-beta\.0/u,
  );
  const emptyDistTags = [
    { status: 1, stdout: "", stderr: "npm error code E404" },
    { status: 0, stdout: "", stderr: "" },
  ];
  assert.throws(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => emptyDistTags.shift(),
      }),
    /empty response.*dist-tags/u,
  );

  assert.throws(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => ({ status: 1, stdout: "", stderr: "npm error code E401" }),
      }),
    /npm query.*E401/u,
  );
  const timeoutError = Object.assign(new Error("spawnSync npm ETIMEDOUT"), {
    code: "ETIMEDOUT",
  });
  assert.throws(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => ({ error: timeoutError, status: null, signal: "SIGTERM" }),
      }),
    /timed out after 60000ms/u,
  );
  assert.throws(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }),
      }),
    /terminated by signal SIGKILL/u,
  );
  const distTagFailure = [
    { status: 1, stdout: "", stderr: "npm error code E404" },
    { status: 1, stdout: "", stderr: "npm error code E503" },
  ];
  assert.throws(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => distTagFailure.shift(),
      }),
    /npm query for @donadiosolutions\/lcm dist-tags.*E503/u,
  );
  const staleResults = [
    { status: 1, stdout: "", stderr: "npm error code E404" },
    { status: 0, stdout: '{"latest":"1.4.1","beta":"1.5.0-beta.1"}', stderr: "" },
  ];
  assert.throws(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => staleResults.shift(),
      }),
    /Refusing to move npm beta/u,
  );
});

test("verifies published npm state without environment-sized JSON payloads", async () => {
  assert.deepEqual(NPM_VERIFY_DELAYS_MS, [2_000, 4_000, 8_000, 16_000]);
  const success = [
    { status: 0, stdout: "1.5.0-beta.2\n", stderr: "" },
    { status: 0, stdout: '["1.4.1","1.5.0-beta.2"]', stderr: "" },
    { status: 0, stdout: '{"latest":"1.4.1","beta":"1.5.0-beta.2"}', stderr: "" },
  ];
  assert.deepEqual(
    await verifyNpmRelease({ version: "1.5.0-beta.2", runNpm: () => success.shift() }),
    {
      versions: ["1.4.1", "1.5.0-beta.2"],
      distTags: { latest: "1.4.1", beta: "1.5.0-beta.2" },
    },
  );
  const firstBeta = [
    { status: 0, stdout: "1.0.0-beta.0\n", stderr: "" },
    { status: 0, stdout: '["1.0.0-beta.0"]', stderr: "" },
    { status: 0, stdout: '{"beta":"1.0.0-beta.0"}', stderr: "" },
  ];
  assert.deepEqual(
    await verifyNpmRelease({
      version: "1.0.0-beta.0",
      runNpm: () => firstBeta.shift(),
      sleep: async () => assert.fail("a complete first beta snapshot must not retry"),
    }),
    {
      versions: ["1.0.0-beta.0"],
      distTags: { beta: "1.0.0-beta.0" },
    },
  );
  await assert.rejects(
    () =>
      verifyNpmRelease({
        version: "1.5.0-beta.2",
        runNpm: (args) =>
          args[1].includes("@1.5.0-beta.2")
            ? { status: 1, stdout: "", stderr: "npm error code E404" }
            : args[2] === "versions"
              ? { status: 0, stdout: '["1.4.1"]', stderr: "" }
              : { status: 0, stdout: '{"latest":"1.4.1","beta":"1.5.0-beta.1"}', stderr: "" },
        sleep: async () => {},
      }),
    /exact version is not visible/u,
  );
  const malformed = [
    { status: 0, stdout: "1.5.0-beta.2", stderr: "" },
    { status: 0, stdout: "not-json", stderr: "" },
    { status: 0, stdout: '{"latest":"1.4.1","beta":"1.5.0-beta.2"}', stderr: "" },
  ];
  await assert.rejects(
    () => verifyNpmRelease({ version: "1.5.0-beta.2", runNpm: () => malformed.shift() }),
    /invalid JSON.*versions/u,
  );
  const emptyDistTags = [
    { status: 0, stdout: "1.5.0-beta.2", stderr: "" },
    { status: 0, stdout: '["1.4.1","1.5.0-beta.2"]', stderr: "" },
    { status: 0, stdout: "", stderr: "" },
  ];
  await assert.rejects(
    () => verifyNpmRelease({ version: "1.5.0-beta.2", runNpm: () => emptyDistTags.shift() }),
    /empty response.*dist-tags/u,
  );
});

test("retries only complete but incompletely propagated npm snapshots", async () => {
  const snapshots = [
    [
      { status: 1, stdout: "", stderr: "npm error code E404" },
      { status: 0, stdout: '["1.4.1"]', stderr: "" },
      { status: 0, stdout: '{"latest":"1.4.1","beta":"1.5.0-beta.1"}', stderr: "" },
    ],
    [
      { status: 0, stdout: "1.5.0-beta.2", stderr: "" },
      { status: 0, stdout: '["1.4.1"]', stderr: "" },
      { status: 0, stdout: '{"latest":"1.4.1","beta":"1.5.0-beta.1"}', stderr: "" },
    ],
    [
      { status: 0, stdout: "1.5.0-beta.2", stderr: "" },
      { status: 0, stdout: '["1.4.1","1.5.0-beta.2"]', stderr: "" },
      { status: 0, stdout: '{"latest":"1.4.1","beta":"1.5.0-beta.1"}', stderr: "" },
    ],
    [
      { status: 0, stdout: "1.5.0-beta.2", stderr: "" },
      { status: 0, stdout: '["1.4.1","1.5.0-beta.2"]', stderr: "" },
      { status: 1, stdout: "", stderr: "npm error code E404" },
    ],
    [
      { status: 0, stdout: "1.5.0-beta.2", stderr: "" },
      { status: 0, stdout: '["1.4.1","1.5.0-beta.2"]', stderr: "" },
      { status: 0, stdout: '{"latest":"1.4.1","beta":"1.5.0-beta.2"}', stderr: "" },
    ],
  ];
  const results = snapshots.flat();
  const delays = [];
  assert.deepEqual(
    await verifyNpmRelease({
      version: "1.5.0-beta.2",
      runNpm: () => results.shift(),
      sleep: async (delay) => delays.push(delay),
    }),
    {
      versions: ["1.4.1", "1.5.0-beta.2"],
      distTags: { latest: "1.4.1", beta: "1.5.0-beta.2" },
    },
  );
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000]);
  assert.equal(results.length, 0);

  let calls = 0;
  await assert.rejects(
    () =>
      verifyNpmRelease({
        version: "1.5.0-beta.2",
        runNpm: () => {
          calls += 1;
          return { status: 1, stdout: "", stderr: "npm error code E401" };
        },
        sleep: async () => assert.fail("authorization failures must not retry"),
      }),
    /E401/u,
  );
  assert.equal(calls, 1);
});

test("sanitizes npm subprocess and unexpected registry failures", () => {
  const secret = `credential-like-${"x".repeat(10_000)}`;
  const assertSanitized = (callback, expected) => {
    assert.throws(callback, (error) => {
      assert.equal(error instanceof Error, true);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /credential-like/u);
      assert.equal(error.cause, undefined);
      return true;
    });
  };

  assertSanitized(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => {
          throw Object.assign(new Error(secret), { code: "E401" });
        },
    }),
    /failed with E401/u,
  );
  assertSanitized(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => {
          throw new Error(secret);
        },
      }),
    /npm query for @donadiosolutions\/lcm@1\.5\.0-beta\.0 failed$/u,
  );
  assertSanitized(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => ({ status: 7, stdout: `${secret} E401`, stderr: secret }),
      }),
    /failed with status 7/u,
  );
  assertSanitized(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => ({ status: 0, stdout: secret, stderr: "" }),
      }),
    /unexpected exact-version response/u,
  );

  const unexpectedDistTags = [
    { status: 1, stdout: "", stderr: "npm error code E404" },
    { status: 0, stdout: JSON.stringify({ latest: secret }), stderr: "" },
  ];
  assertSanitized(
    () =>
      checkNpmReleaseState({
        version: "1.5.0-beta.0",
        runNpm: () => unexpectedDistTags.shift(),
      }),
    /npm latest points to an unsupported version/u,
  );
});

test("enforces monotonic npm channels and a stable latest dist-tag", () => {
  assert.doesNotThrow(() =>
    assertReleaseCanAdvanceDistTag({
      version: "1.5.0-beta.2",
      distTags: { beta: "1.5.0-beta.1", latest: "1.4.1" },
    }),
  );
  assert.throws(
    () =>
      assertReleaseCanAdvanceDistTag({
        version: "1.5.0-beta.1",
        distTags: { beta: "1.5.0-beta.2" },
      }),
    /Refusing to move npm beta/u,
  );
  assert.throws(
    () =>
      assertReleaseCanAdvanceDistTag({
        version: "1.5.0-beta.2",
        distTags: { beta: "1.5.0-beta.1", latest: "1.5.0" },
      }),
    /Refusing to move npm latest/u,
  );
  assert.throws(
    () =>
      assertReleaseCanAdvanceDistTag({
        version: "1.5.0-beta.2",
        distTags: { beta: "1.5.0-beta.1", latest: "not-semver" },
      }),
    /npm latest points to an unsupported version/u,
  );
  assert.throws(
    () =>
      assertReleaseCanAdvanceDistTag({
        version: "1.5.0-beta.2",
        distTags: { beta: "1.4.1", latest: "1.4.1" },
      }),
    /npm beta must point to a canonical beta version/u,
  );
  assert.throws(
    () =>
      assertReleaseCanAdvanceDistTag({
        version: "1.5.0-beta.2",
        distTags: { beta: "1.5.0-beta.1", latest: "1.4.1-beta.0" },
      }),
    /npm latest must point to a canonical stable version/u,
  );
  assert.doesNotThrow(() =>
    assertReleaseCanAdvanceDistTag({
      version: "1.5.0-beta.2",
      distTags: { beta: "1.5.0-beta.2" },
      alreadyPublished: true,
    }),
  );
  assert.doesNotThrow(() =>
    assertNpmDistTags({
      version: "1.5.0-beta.2",
      versions: ["1.4.1", "1.5.0-beta.1", "1.5.0-beta.2"],
      distTags: { latest: "1.4.1", beta: "1.5.0-beta.2" },
    }),
  );
  assert.doesNotThrow(() =>
    assertNpmDistTags({
      version: "1.0.0-beta.0",
      versions: ["1.0.0-beta.0"],
      distTags: { beta: "1.0.0-beta.0" },
    }),
  );
  assert.doesNotThrow(() =>
    assertNpmDistTags({
      version: "1.5.0",
      versions: ["1.4.1", "1.5.0-beta.2", "1.5.0"],
      distTags: { latest: "1.5.0", beta: "1.5.0-beta.2" },
    }),
  );
  assert.throws(
    () =>
      assertNpmDistTags({
        version: "1.5.0-beta.2",
        versions: ["1.4.1", "1.5.0-beta.2"],
        distTags: { latest: "1.5.0-beta.2", beta: "1.5.0-beta.2" },
      }),
    /npm latest must point/u,
  );
});
