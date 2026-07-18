import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const releaseScript = resolve(".agents/skills/lcm-release/scripts/release.sh");
const version = "9.9.9";
const tag = `v${version}`;
const mergeSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const tagObjectSha = "c".repeat(40);
const otherTagObjectSha = "d".repeat(40);

interface HarnessOptions {
  localTagState?: string;
  mergeReachable?: boolean;
  npmVersion?: string;
  originUrl?: string;
  originPushUrls?: string[];
  postPublishRemoteTagState?: string;
  publishMaxWait?: string;
  remoteTagState?: string;
  runId?: string;
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
  const releaseVersion = options.version ?? version;
  const releaseTag = `v${releaseVersion}`;
  mkdirSync(binDir);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@donadiosolutions/lcm" }));
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
  read -r STATE_OBJECT STATE_TARGET STATE_TYPE STATE_SIGNED < "$1"
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
if [[ "$1" == "tag" && "$2" == "-v" ]]; then
  load_state "$FAKE_LOCAL_TAG_STATE"
  [[ "$STATE_SIGNED" == "signed" ]]
  exit
fi
if [[ "$1" == "tag" && "$2" == "-s" && "$3" == "-a" ]]; then
  printf '%s %s tag signed\n' "$FAKE_TAG_OBJECT_SHA" "$5" > "$FAKE_LOCAL_TAG_STATE"
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

printf 'unexpected fake gh invocation: %s\n' "$*" >&2
exit 99
`);

  writeExecutable(join(binDir, "npm"), `#!/usr/bin/env bash
printf 'npm' >> "$FAKE_CALL_LOG"
printf '|%s' "$@" >> "$FAKE_CALL_LOG"
printf '\n' >> "$FAKE_CALL_LOG"
if [[ "$1" == "view" ]]; then
  printf '%s\n' "$FAKE_NPM_VERSION"
  exit 0
fi
exit 99
`);

  writeExecutable(join(binDir, "sleep"), `#!/usr/bin/env bash
printf 'sleep' >> "$FAKE_CALL_LOG"
printf '|%s' "$@" >> "$FAKE_CALL_LOG"
printf '\n' >> "$FAKE_CALL_LOG"
exit 0
`);

  try {
    const result = spawnSync("bash", [releaseScript, releaseVersion, "--from-step", "8"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CALL_LOG: callLog,
        FAKE_LOCAL_TAG_STATE: localTagState,
        FAKE_MERGE_REACHABLE: String(options.mergeReachable ?? true),
        FAKE_MERGE_SHA: mergeSha,
        FAKE_NPM_VERSION: options.npmVersion ?? version,
        FAKE_ORIGIN_URL: options.originUrl ?? "git@github.com:donadiosolutions/lcm.git",
        FAKE_ORIGIN_PUSH_URLS: `${(options.originPushUrls ?? [options.originUrl ?? "git@github.com:donadiosolutions/lcm.git"]).join("\n")}\n`,
        FAKE_POST_PUBLISH_REMOTE_TAG_STATE: postPublishRemoteTagState,
        FAKE_REMOTE_TAG_STATE: remoteTagState,
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

const signedMatchingTag = `${tagObjectSha} ${mergeSha} tag signed`;

describe("manual release helper step 8", () => {
  it("creates and pushes a signed annotated tag at the exact merge SHA", () => {
    const result = runRelease();

    expect(result.status).toBe(0);
    expect(result.localTagState).toBe(signedMatchingTag);
    expect(result.remoteTagState).toBe(signedMatchingTag);
    expect(result.calls).toContain(`git|tag|-s|-a|${tag}|${mergeSha}|-m|Release ${tag}`);
    expect(result.calls).toContain(`git|push|origin|refs/tags/${tag}`);
    expect(result.calls.filter((call: string) => call.startsWith(`git|ls-remote|--tags|origin|refs/tags/${tag}`))).toHaveLength(3);
    expect(result.calls).toContain(`git|rev-parse|refs/tags/${tag}^{commit}`);
    expect(result.stdout).toContain(`published to npm from signed tag ${tag}`);
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

  it("fetches and reuses a matching signed remote tag without pushing it again", () => {
    const result = runRelease({ remoteTagState: signedMatchingTag });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`git|fetch|origin|refs/tags/${tag}:refs/tags/${tag}`);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
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
    expect(result.stderr).toContain(`Local tag ${tag} does not have a valid cryptographic signature`);
    expect(result.calls).not.toContain(`git|push|origin|refs/tags/${tag}`);
  });

  it("refuses to tag a merge commit that is not reachable from origin main", () => {
    const result = runRelease({ mergeReachable: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Merge commit ${mergeSha} is not reachable from origin/main`);
    expect(result.calls.some((call: string) => call.startsWith("git|tag|-s|-a|"))).toBe(false);
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

  it.each(["-1", "10s", "1.5"])(
    "rejects invalid PUBLISH_MAX_WAIT value %s",
    (publishMaxWait: string) => {
      const result = runRelease({ publishMaxWait });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PUBLISH_MAX_WAIT must be a non-negative integer in seconds");
    },
  );

  it.each(["0", "1", "08", "09", "900"])(
    "accepts PUBLISH_MAX_WAIT boundary %s",
    (publishMaxWait: string) => {
      const result = runRelease({ publishMaxWait });

      expect(result.status).toBe(0);
    },
  );

  it.each(["1.2.3-beta.1", "1.2.3+build.1"])(
    "rejects unsupported release version %s before repository access",
    (releaseVersion: string) => {
      const result = runRelease({ version: releaseVersion });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("prerelease and build metadata versions are not supported");
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

  it("retains npm publication verification after a successful workflow", () => {
    const result = runRelease({ npmVersion: "" });

    expect(result.status).toBe(1);
    expect(result.calls).toContain(`npm|view|@donadiosolutions/lcm@${version}|version`);
    expect(result.stderr).toContain(`publish.yml succeeded but @donadiosolutions/lcm@${version} was not found on npm`);
  });
});
