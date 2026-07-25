import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseScript = fileURLToPath(
  new URL("../../.agents/skills/lcm-release/scripts/release.sh", import.meta.url),
);
const releasePolicyFixtures = fileURLToPath(
  new URL("../../.github/scripts/", import.meta.url),
);
const version = "9.9.9";
const tag = `v${version}`;
const mergeSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const tagObjectSha = "c".repeat(40);
const otherTagObjectSha = "d".repeat(40);

interface HarnessOptions {
  changelogContent?: string;
  localTagState?: string;
  mergeSha?: string;
  mergeReachable?: boolean;
  mergedPackageVersion?: string;
  npmVersion?: string;
  npmDistTags?: string;
  originUrl?: string;
  originPushUrls?: string[];
  postPublishRemoteTagState?: string;
  preTagNpmError?: string;
  preTagNpmVersion?: string;
  publishMaxWait?: string;
  releaseDraft?: boolean;
  releasePrerelease?: boolean;
  releaseTag?: string;
  remoteTagState?: string;
  runId?: string;
  realSleep?: boolean;
  version?: string;
}

interface HarnessResult {
  calls: string[];
  localTagState: string | null;
  remoteTagState: string | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function runRelease(options: HarnessOptions = {}): HarnessResult {
  const root = mkdtempSync(join(tmpdir(), "lcm-release-helper-"));
  const binDir = join(root, "bin");
  const callLog = join(root, "calls.log");
  const localTagState = join(root, "local-tag.state");
  const remoteTagState = join(root, "remote-tag.state");
  const postPublishRemoteTagState = join(root, "post-publish-remote-tag.state");
  const npmPreTagChecked = join(root, "npm-pretag-checked.state");
  const releaseVersion = options.version ?? version;
  const releaseTag = `v${releaseVersion}`;
  const releaseMergeSha = options.mergeSha ?? mergeSha;
  mkdirSync(binDir);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@donadiosolutions/lcm" }));
  const scriptsDir = join(root, ".github", "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const scriptName of [
    "check-npm-release-state.mjs",
    "npm-release-policy.mjs",
    "release-tag-policy.mjs",
  ]) {
    writeFileSync(
      join(scriptsDir, scriptName),
      readFileSync(join(releasePolicyFixtures, scriptName), "utf8"),
    );
  }
  if (options.localTagState) writeFileSync(localTagState, options.localTagState);
  if (options.remoteTagState) writeFileSync(remoteTagState, options.remoteTagState);
  if (options.postPublishRemoteTagState !== undefined) {
    writeFileSync(postPublishRemoteTagState, options.postPublishRemoteTagState);
  }

  writeExecutable(join(binDir, "git"), `#!/usr/bin/env bash
printf 'git' >> "$FAKE_CALL_LOG"
printf '|%s' "$@" >> "$FAKE_CALL_LOG"
printf '\n' >> "$FAKE_CALL_LOG"

load_state() {
  read -r STATE_OBJECT STATE_TARGET STATE_TYPE STATE_SIGNED STATE_TAG_NAME < "$1"
  STATE_TAG_NAME="\${STATE_TAG_NAME:-$FAKE_TAG}"
}

if [[ "$1" == "rev-parse" && "$2" == "--show-toplevel" ]]; then
  printf '%s\n' "$FAKE_REPO_ROOT"
  exit 0
fi
if [[ "$1" == "remote" && "$2" == "get-url" && "$3" == "origin" ]]; then
  printf '%s\n' "$FAKE_ORIGIN_URL"
  exit 0
fi
if [[ "$1" == "remote" && "$2" == "get-url" && "$3" == "--push" && "$4" == "--all" && "$5" == "origin" ]]; then
  printf '%s' "$FAKE_ORIGIN_PUSH_URLS"
  exit 0
fi
if [[ "$1" == "fetch" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == refs/tags/*:refs/tags/* ]]; then
      cp "$FAKE_REMOTE_TAG_STATE" "$FAKE_LOCAL_TAG_STATE"
    fi
  done
  exit 0
fi
if [[ "$1" == "merge-base" && "$2" == "--is-ancestor" ]]; then
  [[ "$FAKE_MERGE_REACHABLE" == "true" ]]
  exit
fi
if [[ "$1" == "show" && "$2" == *:package.json ]]; then
  printf '{"version":"%s"}\n' "$FAKE_MERGED_PACKAGE_VERSION"
  exit 0
fi
if [[ "$1" == "show" && "$2" == *:CHANGELOG.md ]]; then
  printf '%s' "$FAKE_CHANGELOG_CONTENT"
  exit 0
fi
if [[ "$1" == "ls-remote" && "$2" == "--tags" ]]; then
  if [[ -f "$FAKE_REMOTE_TAG_STATE" ]]; then
    load_state "$FAKE_REMOTE_TAG_STATE"
    if [[ "$STATE_TYPE" == "tag" ]]; then
      printf '%s\trefs/tags/%s\n' "$STATE_OBJECT" "$FAKE_TAG"
      printf '%s\trefs/tags/%s^{}\n' "$STATE_TARGET" "$FAKE_TAG"
    else
      printf '%s\trefs/tags/%s\n' "$STATE_TARGET" "$FAKE_TAG"
    fi
  fi
  exit 0
fi
if [[ "$1" == "rev-parse" && "$2" == "--verify" && "$3" == "--quiet" ]]; then
  [[ -f "$FAKE_LOCAL_TAG_STATE" ]]
  exit
fi
if [[ "$1" == "rev-parse" && "$2" == "refs/tags/$FAKE_TAG" ]]; then
  load_state "$FAKE_LOCAL_TAG_STATE"
  if [[ "$STATE_TYPE" == "tag" ]]; then printf '%s\n' "$STATE_OBJECT"; else printf '%s\n' "$STATE_TARGET"; fi
  exit 0
fi
if [[ "$1" == "rev-parse" && "$2" == "refs/tags/$FAKE_TAG^{commit}" ]]; then
  load_state "$FAKE_LOCAL_TAG_STATE"
  printf '%s\n' "$STATE_TARGET"
  exit 0
fi
if [[ "$1" == "cat-file" && "$2" == "-t" ]]; then
  load_state "$FAKE_LOCAL_TAG_STATE"
  printf '%s\n' "$STATE_TYPE"
  exit 0
fi
if [[ "$1" == "cat-file" && "$2" == "-p" ]]; then
  load_state "$FAKE_LOCAL_TAG_STATE"
  printf 'object %s\ntype commit\ntag %s\n' "$STATE_TARGET" "$STATE_TAG_NAME"
  exit 0
fi
if [[ "$1" == "tag" && "$2" == "-v" ]]; then
  load_state "$FAKE_LOCAL_TAG_STATE"
  [[ "$STATE_SIGNED" == "signed" ]]
  exit
fi
if [[ "$1" == "tag" && "$2" == "-s" && "$3" == "-a" ]]; then
  printf '%s %s tag signed %s\n' "$FAKE_TAG_OBJECT_SHA" "$5" "$FAKE_TAG" > "$FAKE_LOCAL_TAG_STATE"
  exit 0
fi
if [[ "$1" == "push" && "$2" == "origin" && "$3" == "refs/tags/$FAKE_TAG" ]]; then
  cp "$FAKE_LOCAL_TAG_STATE" "$FAKE_REMOTE_TAG_STATE"
  exit 0
fi

printf 'unexpected fake git invocation: %s\n' "$*" >&2
exit 99
`);

  writeExecutable(join(binDir, "gh"), `#!/usr/bin/env bash
printf 'gh' >> "$FAKE_CALL_LOG"
printf '|%s' "$@" >> "$FAKE_CALL_LOG"
printf '\n' >> "$FAKE_CALL_LOG"

if [[ "$1" == "pr" && "$2" == "list" ]]; then
  printf '%s\n' "$FAKE_MERGE_SHA"
  exit 0
fi
if [[ "$1" == "run" && "$2" == "list" ]]; then
  printf '%s\n' "$FAKE_RUN_ID"
  exit 0
fi
if [[ "$1" == "run" && "$2" == "watch" ]]; then
  if [[ -f "$FAKE_POST_PUBLISH_REMOTE_TAG_STATE" ]]; then
    if [[ -s "$FAKE_POST_PUBLISH_REMOTE_TAG_STATE" ]]; then
      cp "$FAKE_POST_PUBLISH_REMOTE_TAG_STATE" "$FAKE_REMOTE_TAG_STATE"
    else
      rm -f "$FAKE_REMOTE_TAG_STATE"
    fi
  fi
  exit 0
fi
if [[ "$1" == "run" && "$2" == "view" ]]; then
  printf 'success\n'
  exit 0
fi
if [[ "$1" == "release" && "$2" == "view" ]]; then
  printf '%s\t%s\t%s\n' "$FAKE_RELEASE_DRAFT" "$FAKE_RELEASE_PRERELEASE" "$FAKE_RELEASE_TAG"
  exit 0
fi

printf 'unexpected fake gh invocation: %s\n' "$*" >&2
exit 99
`);

  writeExecutable(join(binDir, "npm"), `#!/usr/bin/env bash
printf 'npm' >> "$FAKE_CALL_LOG"
printf '|%s' "$@" >> "$FAKE_CALL_LOG"
printf '\n' >> "$FAKE_CALL_LOG"
if [[ "$1" == "view" ]]; then
  if [[ "$2" == "@donadiosolutions/lcm" && "$3" == "dist-tags" ]]; then
    if [[ -n "$FAKE_NPM_DIST_TAGS" ]]; then
      printf '%s\n' "$FAKE_NPM_DIST_TAGS"
      exit 0
    fi
    printf 'npm ERR! code E404\n' >&2
    exit 1
  fi
  if [[ ! -f "$FAKE_REMOTE_TAG_STATE" && ! -f "$FAKE_NPM_PRETAG_CHECKED" ]]; then
    : > "$FAKE_NPM_PRETAG_CHECKED"
    if [[ -n "$FAKE_PRETAG_NPM_VERSION" ]]; then
      printf '%s\n' "$FAKE_PRETAG_NPM_VERSION"
      exit 0
    fi
    if [[ -n "$FAKE_PRETAG_NPM_ERROR" ]]; then
      printf '%s\n' "$FAKE_PRETAG_NPM_ERROR" >&2
      exit 1
    fi
    printf 'npm ERR! code E404\n' >&2
    exit 1
  fi
  if [[ -n "$FAKE_NPM_VERSION" ]]; then
    printf '%s\n' "$FAKE_NPM_VERSION"
    exit 0
  fi
  printf 'npm ERR! code E404\n' >&2
  exit 1
fi
exit 99
`);

writeExecutable(join(binDir, "sleep"), `#!/usr/bin/env bash
printf 'sleep' >> "$FAKE_CALL_LOG"
printf '|%s' "$@" >> "$FAKE_CALL_LOG"
printf '\n' >> "$FAKE_CALL_LOG"
if [[ "$FAKE_REAL_SLEEP" == "true" ]]; then
  /bin/sleep "$1"
fi
exit 0
`);

  try {
    const result = spawnSync("bash", [releaseScript, releaseVersion, "--from-step", "8"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CALL_LOG: callLog,
        FAKE_CHANGELOG_CONTENT: options.changelogContent ?? `## ${releaseVersion}\n\n- Release notes\n`,
        FAKE_LOCAL_TAG_STATE: localTagState,
        FAKE_MERGE_REACHABLE: String(options.mergeReachable ?? true),
        FAKE_MERGE_SHA: releaseMergeSha,
        FAKE_MERGED_PACKAGE_VERSION: options.mergedPackageVersion ?? releaseVersion,
        FAKE_NPM_VERSION: options.npmVersion ?? "",
        FAKE_NPM_DIST_TAGS: options.npmDistTags ?? "",
        FAKE_NPM_PRETAG_CHECKED: npmPreTagChecked,
        FAKE_ORIGIN_URL: options.originUrl ?? "git@github.com:donadiosolutions/lcm.git",
        FAKE_ORIGIN_PUSH_URLS: `${(options.originPushUrls ?? [options.originUrl ?? "git@github.com:donadiosolutions/lcm.git"]).join("\n")}\n`,
        FAKE_POST_PUBLISH_REMOTE_TAG_STATE: postPublishRemoteTagState,
        FAKE_PRETAG_NPM_ERROR: options.preTagNpmError ?? "",
        FAKE_PRETAG_NPM_VERSION: options.preTagNpmVersion ?? "",
        FAKE_REMOTE_TAG_STATE: remoteTagState,
        FAKE_REAL_SLEEP: String(options.realSleep ?? false),
        FAKE_RELEASE_DRAFT: String(options.releaseDraft ?? true),
        FAKE_RELEASE_PRERELEASE: String(
          options.releasePrerelease ?? releaseVersion.includes("-beta."),
        ),
        FAKE_RELEASE_TAG: options.releaseTag ?? releaseTag,
        FAKE_REPO_ROOT: root,
        FAKE_RUN_ID: options.runId ?? "9001",
        FAKE_TAG: releaseTag,
        FAKE_TAG_OBJECT_SHA: tagObjectSha,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        PUBLISH_MAX_WAIT: options.publishMaxWait ?? "0",
      },
    });
    return {
      calls: existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : [],
      localTagState: existsSync(localTagState) ? readFileSync(localTagState, "utf8").trim() : null,
      remoteTagState: existsSync(remoteTagState) ? readFileSync(remoteTagState, "utf8").trim() : null,
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const signedMatchingTag = `${tagObjectSha} ${mergeSha} tag signed ${tag}`;

describe("manual release helper step 8", () => {
  it("uses a monotonic clock for the publication timeout", () => {
    const script = readFileSync(releaseScript, "utf8");

    expect(script).toContain("process.hrtime.bigint()");
    expect(script).not.toContain("$SECONDS");
  });

  it("rejects numeric version components outside npm's safe-integer range", () => {
    const result = runRelease({ version: "9007199254740992.1.1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("within npm's JavaScript safe-integer range");
    expect(result.calls).toEqual([]);
  });

  it("creates and pushes a signed annotated tag at the exact merge SHA", () => {
    const result = runRelease();

    expect(result.status).toBe(0);
    expect(result.localTagState).toBe(signedMatchingTag);
    expect(result.remoteTagState).toBe(signedMatchingTag);
    expect(result.calls).toContain(`git|tag|-s|-a|${tag}|${mergeSha}|-m|Release ${tag}`);
    expect(result.calls).toContain(`git|push|origin|refs/tags/${tag}`);
    expect(result.calls.filter((call: string) => call.startsWith(`git|ls-remote|--tags|origin|refs/tags/${tag}`))).toHaveLength(3);
    expect(result.calls).toContain(`git|rev-parse|refs/tags/${tag}^{commit}`);
    expect(result.stdout).toContain(`Draft GitHub release ${tag} is ready`);
    expect(result.stdout).toContain("Publish the draft manually in GitHub to trigger npm publication");
  });

  it("finds the tag-triggered publish run by tag and head SHA without filtering main", () => {
    const result = runRelease();
    const runListCall = result.calls.find((call: string) => call.startsWith("gh|run|list|"));

    expect(result.status).toBe(0);
    expect(runListCall).toContain("|--event|push|");
    expect(runListCall).toContain("|--json|databaseId,headSha,headBranch|");
    expect(runListCall).toContain(`.headSha == "${mergeSha}" and .headBranch == "${tag}"`);
    expect(runListCall).not.toContain("|--branch|main|");
  });

  it("accepts beta versions and verifies a draft GitHub prerelease", () => {
    const betaVersion = "10.0.0-beta.0";
    const betaTag = `v${betaVersion}`;
    const result = runRelease({ version: betaVersion });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`git|tag|-s|-a|${betaTag}|${mergeSha}|-m|Release ${betaTag}`);
    expect(result.stdout).toContain(`Draft GitHub release ${betaTag} is ready`);
  });

  it.each([
    {
      releaseVersion: "10.0.0-beta.0",
      distTags: '{"latest":"9.9.9","beta":"10.0.0-beta.1"}',
    },
    {
      releaseVersion: "9.9.9",
      distTags: '{"latest":"10.0.0"}',
    },
    {
      releaseVersion: "9.9.9-beta.0",
      distTags: '{"latest":"9.9.9","beta":"9.9.8-beta.1"}',
    },
  ])(
    "rejects stale npm channel ordering before repository mutation for $releaseVersion",
    ({ releaseVersion, distTags }: { releaseVersion: string; distTags: string }) => {
      const result = runRelease({ version: releaseVersion, npmDistTags: distTags });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`npm release ordering rejects ${releaseVersion}`);
      expect(
        result.calls.some((call: string) =>
          /^(?:git\|(fetch|pull|checkout|tag|push)|gh\|)/u.test(call),
        ),
      ).toBe(false);
    },
  );

  it("fetches and reuses a matching signed remote tag without pushing it again", () => {
    const result = runRelease({ remoteTagState: signedMatchingTag });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`git|fetch|origin|refs/tags/${tag}:refs/tags/${tag}`);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("pushes a matching signed local tag when the remote tag is absent", () => {
    const result = runRelease({ localTagState: signedMatchingTag });

    expect(result.status).toBe(0);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
    expect(result.calls).toContain(`git|push|origin|refs/tags/${tag}`);
    expect(result.remoteTagState).toBe(signedMatchingTag);
  });

  it("reuses matching local and remote signed tag objects idempotently", () => {
    const result = runRelease({
      localTagState: signedMatchingTag,
      remoteTagState: signedMatchingTag,
    });

    expect(result.status).toBe(0);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
    expect(result.calls).not.toContain(`git|fetch|origin|refs/tags/${tag}:refs/tags/${tag}`);
  });

  it("refuses different signed local and remote tag objects for the same target", () => {
    const result = runRelease({
      localTagState: signedMatchingTag,
      remoteTagState: `${otherTagObjectSha} ${mergeSha} tag signed`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Local and remote ${tag} tag objects differ`);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
    expect(result.calls.some((call: string) => call.startsWith("gh|run|list|"))).toBe(false);
  });

  it("aborts when a remote version tag targets a different commit", () => {
    const result = runRelease({
      remoteTagState: `${tagObjectSha} ${otherSha} tag signed`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Remote tag ${tag} points to ${otherSha}, not merge commit ${mergeSha}`);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
    expect(result.calls.some((call: string) => call.startsWith("gh|run|list|"))).toBe(false);
  });

  it("aborts when a local version tag targets a different commit", () => {
    const result = runRelease({
      localTagState: `${tagObjectSha} ${otherSha} tag signed`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Local tag ${tag} points to ${otherSha}, not merge commit ${mergeSha}`);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("rejects an existing lightweight tag instead of overwriting it", () => {
    const result = runRelease({
      localTagState: `${mergeSha} ${mergeSha} commit unsigned`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Local tag ${tag} is not annotated`);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("rejects a matching lightweight remote tag instead of fetching it", () => {
    const result = runRelease({
      remoteTagState: `${mergeSha} ${mergeSha} commit unsigned`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Remote tag ${tag} is not annotated`);
    expect(result.calls).not.toContain(`git|fetch|origin|refs/tags/${tag}:refs/tags/${tag}`);
  });

  it("rejects an unsigned annotated local tag", () => {
    const result = runRelease({
      localTagState: `${tagObjectSha} ${mergeSha} tag unsigned`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Could not verify the cryptographic signature on local tag ${tag}`);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("rejects a signed tag object whose embedded name differs from its ref", () => {
    const result = runRelease({
      localTagState: `${tagObjectSha} ${mergeSha} tag signed v9.9.8`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`tag ref ${tag} contains a signed tag object naming v9.9.8`);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("refuses to tag a merge commit that is not reachable from origin main", () => {
    const result = runRelease({ mergeReachable: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Merge commit ${mergeSha} is not reachable from origin/main`);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
  });

  it("refuses to tag a merge commit whose package version differs", () => {
    const result = runRelease({ mergedPackageVersion: "9.9.8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`package=9.9.8; expected ${version}`);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("refuses to create a missing release tag for an already-published npm version", () => {
    const result = runRelease({ preTagNpmVersion: version });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${version} is already published to npm`);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("reports a bounded diagnostic when the pre-tag npm query fails", () => {
    const registryDetail = `registry-secret-detail-${"x".repeat(10_000)}`;
    const result = runRelease({ preTagNpmError: registryDetail });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `✗ ERROR: npm release ordering rejects ${version}; no repository or tag mutation was attempted.\n`,
    );
    expect(result.stderr).not.toContain("registry-secret-detail-");
    expect(result.stdout).not.toContain("registry-secret-detail-");
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
  });

  it.each([
    "",
    `## ${version}\n\n## 9.9.8\n\n- Older notes\n`,
    `## ${version}\n\n   \n## 9.9.8\n\n- Older notes\n`,
  ])("refuses a missing or empty release changelog block before tagging", (changelogContent: string) => {
    const result = runRelease({ changelogContent });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`has no nonempty CHANGELOG.md block for ${version}`);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("uses the formatted origin error after helper declarations", () => {
    const result = runRelease({ originUrl: "git@github.com:example/lcm.git" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`✗ ERROR: origin does not point to donadiosolutions/lcm`);
    expect(result.stderr).not.toContain("command not found");
  });

  it.each([
    `https://github.com/donadiosolutions/lcm`,
    `https://github.com/donadiosolutions/lcm.git`,
    `git@github.com:donadiosolutions/lcm`,
    `git@github.com:donadiosolutions/lcm.git`,
    `ssh://git@github.com/donadiosolutions/lcm`,
    `ssh://git@github.com/donadiosolutions/lcm.git`,
  ])("accepts canonical origin URL %s", (originUrl: string) => {
    const result = runRelease({ originUrl });

    expect(result.status).toBe(0);
  });

  it.each([
    `https://github.com/donadiosolutions/lcm-fork.git`,
    `https://github.com/example/donadiosolutions/lcm.git`,
    `git@github.com:donadiosolutions/lcm-mirror.git`,
    `git@github.com:mirror/donadiosolutions/lcm.git`,
    `ssh://git@github.com/donadiosolutions/lcm/extra`,
  ])("rejects origin URL collision %s", (originUrl: string) => {
    const result = runRelease({ originUrl });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`origin does not point to donadiosolutions/lcm`);
    expect(result.calls.some((call: string) => call.startsWith("gh|pr|list|"))).toBe(false);
  });

  it("rejects a non-canonical push URL even when the fetch URL is canonical", () => {
    const result = runRelease({ originPushUrls: ["git@github.com:example/lcm.git"] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("origin must have exactly one canonical push URL");
    expect(result.calls.some((call: string) => call.startsWith("gh|pr|list|"))).toBe(false);
  });

  it("rejects multiple push URLs even when each one is canonical", () => {
    const canonical = "git@github.com:donadiosolutions/lcm.git";
    const result = runRelease({ originPushUrls: [canonical, canonical] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("origin must have exactly one canonical push URL");
  });

  it("reports a missing push URL explicitly", () => {
    const result = runRelease({ originPushUrls: [] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("got: (none)");
  });

  it("canonicalizes uppercase merge SHAs before comparisons and workflow lookup", () => {
    const result = runRelease({ mergeSha: mergeSha.toUpperCase() });
    const runListCall = result.calls.find((call: string) => call.startsWith("gh|run|list|"));

    expect(result.status).toBe(0);
    expect(result.localTagState).toBe(signedMatchingTag);
    expect(runListCall).toContain(`.headSha == "${mergeSha}"`);
  });

  it.each(["-1", "10s", "1.5", "9223372036854775808", "999999999999999999999999"])(
    "rejects invalid PUBLISH_MAX_WAIT value %s",
    (publishMaxWait: string) => {
      const result = runRelease({ publishMaxWait });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PUBLISH_MAX_WAIT must be a non-negative integer in seconds");
      expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
      expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
    },
  );

  it.each(["0", "1", "08", "09", "900", "9223372036854775807"])(
    "accepts PUBLISH_MAX_WAIT boundary %s",
    (publishMaxWait: string) => {
      const result = runRelease({ publishMaxWait });

      expect(result.status).toBe(0);
    },
  );

  it("caps polling sleep at the remaining monotonic timeout", () => {
    const result = runRelease({ publishMaxWait: "2", realSleep: true, runId: "" });
    const sleepCalls = result.calls.filter((call: string) => call.startsWith("sleep|"));

    expect(result.status).toBe(1);
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls.every((call: string) => Number(call.slice("sleep|".length)) <= 2)).toBe(true);
    expect(result.stderr).toContain(`not found after 2s`);
  });

  it.each(["1.2.3-alpha.1", "1.2.3-rc.1", "1.2.3+build.1"])(
    "rejects unsupported release version %s before repository access",
    (releaseVersion: string) => {
      const result = runRelease({ version: releaseVersion });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("other prerelease and build metadata versions are not supported");
      expect(result.calls).toEqual([]);
    },
  );

  it.each(["01.2.3", "1.02.3", "1.2.03"])(
    "rejects stable-looking versions with leading zeros before repository access",
    (releaseVersion: string) => {
      const result = runRelease({ version: releaseVersion });

      expect(result.status).toBe(1);
      expect(result.calls).toEqual([]);
    },
  );

  it("fails final verification when the remote tag is deleted after publication", () => {
    const result = runRelease({ postPublishRemoteTagState: "" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`git tag ${tag} does not resolve to merge commit ${mergeSha}`);
  });

  it("fails final verification when the remote tag moves after publication", () => {
    const result = runRelease({ postPublishRemoteTagState: `${otherTagObjectSha} ${otherSha} tag signed` });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`git tag ${tag} does not resolve to merge commit ${mergeSha}`);
  });

  it("fails final verification when the remote tag object is replaced at the same commit", () => {
    const result = runRelease({
      postPublishRemoteTagState: `${otherTagObjectSha} ${mergeSha} tag signed`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`git tag ${tag} does not resolve to merge commit ${mergeSha}`);
  });

  it("fails the global guard when npm was published before the draft release was finalized", () => {
    const result = runRelease({ npmVersion: version });

    expect(result.status).toBe(1);
    expect(result.calls).toContain(`npm|view|@donadiosolutions/lcm@${version}|version`);
    expect(result.stderr).toContain(`${version} is already published to npm`);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
  });

  it("fails when the tag workflow does not leave a draft release", () => {
    const result = runRelease({ releaseDraft: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`GitHub release ${tag} is not a draft`);
  });

  it("fails when the GitHub prerelease flag does not match the beta version", () => {
    const result = runRelease({
      version: "10.0.0-beta.0",
      releasePrerelease: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prerelease flag is false, expected true");
  });

  it("fails when the draft release points at another tag", () => {
    const result = runRelease({ releaseTag: "v9.9.8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`GitHub draft release tag is v9.9.8, expected ${tag}`);
  });
});
