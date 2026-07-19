import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEASE_DRAFT_MARKER,
  assertActionCreatedReleaseBody,
  assertNpmDistTags,
  assertReleaseCanAdvanceDistTag,
  associateCommitsWithPullRequests,
  buildHighlightsPrompt,
  categorizeReleasePullRequests,
  classifyPullRequest,
  collectReleasePullRequests,
  compareReleaseVersions,
  parseChangesetDocument,
  parseHighlightsResult,
  parseReleaseTag,
  renderReleaseNotes,
  selectPreviousRelease,
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

test("classifies major changesets before PR labels and fails on conflicting labels", () => {
  assert.equal(classifyPullRequest(pr(1, ["bug"]), [changeset("major")]), "breaking");
  assert.equal(classifyPullRequest(pr(2, ["enhancement"])), "features");
  assert.equal(classifyPullRequest(pr(3, ["bug"])), "fixes");
  assert.equal(classifyPullRequest(pr(4)), "extra");
  assert.equal(classifyPullRequest(pr(5, ["no-release-notes"])), undefined);
  assert.equal(
    classifyPullRequest(pr(6, [], { head: { ref: "changeset-release/main" } })),
    undefined,
  );
  assert.throws(() => classifyPullRequest(pr(7, ["bug", "enhancement"])), /conflicting/u);
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
    { pr: pr(3, ["bug"]) },
    { pr: pr(2, ["enhancement"]) },
    { pr: pr(1), changesetContents: [changeset("major", "Break an API.")] },
    { pr: pr(2, ["enhancement"]) },
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

  const entries = await collectReleasePullRequests({
    github,
    owner: "donadiosolutions",
    repo: "lcm",
    baseTag: "v1.4.1",
    targetTag: "v1.5.0",
    runGit: () => commit,
  });

  assert.deepEqual(entries, [{ pr: associatedPullRequest, changesetContents: [] }]);
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
    { pr: pr(1, ["enhancement"]), changesetContents: [changeset("minor", "Add beta releases.")] },
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

test("renders Highlights always and omits empty release sections", () => {
  const categorized = categorizeReleasePullRequests([
    { pr: pr(1, ["enhancement"], { title: "Add [beta] support" }) },
    { pr: pr(2) },
  ]);
  const notes = renderReleaseNotes({ highlights: ["Beta releases are now available."], categorized });
  assert.match(notes, new RegExp(RELEASE_DRAFT_MARKER));
  assert.match(notes, /## Highlights/u);
  assert.doesNotMatch(notes, /## Breaking changes/u);
  assert.match(notes, /## Features/u);
  assert.doesNotMatch(notes, /## Fixes/u);
  assert.match(notes, /## Extra notes/u);
  assert.ok(notes.includes("Add \\[beta\\] support (#1)"));
  assertActionCreatedReleaseBody(notes);
  assert.throws(() => assertActionCreatedReleaseBody("## Highlights\n\n- Missing marker"), /not created/u);
  assert.throws(() => renderReleaseNotes({ highlights: [], categorized }), /at least one/u);
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
