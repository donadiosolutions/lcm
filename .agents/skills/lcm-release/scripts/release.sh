#!/usr/bin/env bash
# lcm-release — full end-to-end release script
#
# Usage:
#   ./release.sh <version>               Run all steps (0-8)
#   ./release.sh <version> --from-step N Resume from step N after a failure
#
# Steps:
#   0  Clean state + sync main
#   1  Guard: verify tag and npm version are free
#   2  Create release branch
#   3  Bump version files + CHANGELOG.md + verify
#   4  Commit and push
#   5  Open PR targeting main
#   6  Wait for CI
#   7  Merge release PR
#   8  Create/verify signed release tag and wait for the draft GitHub release
set -euo pipefail

# ─── Args ────────────────────────────────────────────────────────────────────
VERSION=""
FROM_STEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-step)
      FROM_STEP="${2:-}"
      [[ -z "$FROM_STEP" ]] && { echo "--from-step requires a number (0-8)"; exit 1; }
      if ! [[ "$FROM_STEP" =~ ^[0-8]$ ]]; then
        echo "Invalid --from-step '$FROM_STEP'; must be an integer between 0 and 8."
        echo "Usage: $0 <version> [--from-step N]"
        exit 1
      fi
      shift 2
      ;;
    --from-step=*)
      FROM_STEP="${1#*=}"
      if ! [[ "$FROM_STEP" =~ ^[0-8]$ ]]; then
        echo "Invalid --from-step '$FROM_STEP'; must be an integer between 0 and 8."
        echo "Usage: $0 <version> [--from-step N]"
        exit 1
      fi
      shift
      ;;
    -*)
      echo "Unknown flag: $1"; exit 1
      ;;
    *)
      VERSION="$1"
      shift
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [--from-step N]"
  echo "       $0 0.4.2"
  echo "       $0 0.4.2 --from-step 8   # create/verify tag and resume draft creation"
  exit 1
fi

# Validate version is semver (fail fast, also guards node interpolation)
SEMVER_REGEX='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-beta\.(0|[1-9][0-9]*))?$'
if ! [[ "$VERSION" =~ $SEMVER_REGEX ]]; then
  echo "Invalid version '$VERSION'. Expected a stable version like '0.4.2' or beta like '0.5.0-beta.0'; other prerelease and build metadata versions are not supported."
  echo "Usage: $0 <version> [--from-step N]"
  exit 1
fi
if ! node -e '
  const parts = process.argv[1].match(/[0-9]+/g) ?? [];
  process.exit(parts.every((part) => Number.isSafeInteger(Number(part))) ? 0 : 1);
' "$VERSION"; then
  echo "Invalid version '$VERSION'. Each numeric component must be within npm's JavaScript safe-integer range."
  exit 1
fi

# ─── Repo root ───────────────────────────────────────────────────────────────
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || \
  { echo "✗ ERROR: Not inside a git repository."; exit 1; }
cd "$REPO_ROOT"

# ─── Helpers ─────────────────────────────────────────────────────────────────
REPO="donadiosolutions/lcm"
RELEASE_BRANCH="release/v$VERSION"
PACKAGE_NAME=$(node -p "require('./package.json').name")

err()    { echo ""; echo "✗ ERROR: $*" >&2; exit 1; }
step()   { echo ""; echo "━━━ $* ━━━"; }
ok()     { echo "  ✓ $*"; }
skip()   { echo "  (skipping — already past this step)"; }
run_step() { [[ "$1" -ge "$FROM_STEP" ]]; }  # true if step N should run

monotonic_seconds() {
  node -e 'process.stdout.write(String(process.hrtime.bigint() / 1000000000n));'
}

is_canonical_origin() {
  case "$1" in
    "https://github.com/$REPO" | \
      "https://github.com/$REPO.git" | \
      "git@github.com:$REPO" | \
      "git@github.com:$REPO.git" | \
      "ssh://git@github.com/$REPO" | \
      "ssh://git@github.com/$REPO.git")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remote_tag_refs() {
  git ls-remote --tags origin "refs/tags/$1" "refs/tags/$1^{}"
}

tag_object_from_refs() {
  local tag="$1"
  awk -v tag_ref="refs/tags/$tag" '$2 == tag_ref { print $1; exit }'
}

tag_target_from_refs() {
  local tag="$1"
  awk -v tag_ref="refs/tags/$tag" -v peeled_ref="refs/tags/$tag^{}" '
    $2 == tag_ref { tag_object = $1 }
    $2 == peeled_ref { peeled = $1 }
    END {
      if (peeled != "") print peeled
      else if (tag_object != "") print tag_object
    }
  '
}

tag_peeled_from_refs() {
  local tag="$1"
  awk -v peeled_ref="refs/tags/$tag^{}" '$2 == peeled_ref { print $1; exit }'
}

commit_json_version() {
  local commit="$1"
  local path="$2"
  git show "$commit:$path" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      process.stdout.write(String(parsed.version ?? ""));
    });
  '
}

# Validate origin points at the canonical repo (not a fork)
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || true)
if ! is_canonical_origin "$ORIGIN_URL"; then
  err "origin does not point to $REPO (got: $ORIGIN_URL). Run from the canonical repo, not a fork."
fi
ORIGIN_PUSH_URLS=()
while IFS= read -r push_url; do
  [[ -n "$push_url" ]] && ORIGIN_PUSH_URLS+=("$push_url")
done < <(git remote get-url --push --all origin 2>/dev/null || true)
ORIGIN_PUSH_URL_DISPLAY="(none)"
[[ "${#ORIGIN_PUSH_URLS[@]}" -gt 0 ]] && ORIGIN_PUSH_URL_DISPLAY="${ORIGIN_PUSH_URLS[*]}"
if [[ "${#ORIGIN_PUSH_URLS[@]}" -ne 1 ]] || ! is_canonical_origin "${ORIGIN_PUSH_URLS[0]:-}"; then
  err "origin must have exactly one canonical push URL for $REPO (got: $ORIGIN_PUSH_URL_DISPLAY)."
fi

# Fail stale stable/beta releases before pulling, branching, committing, or tagging.
NPM_GUARD_OUTPUT=""
if ! NPM_GUARD_OUTPUT=$(node .github/scripts/check-npm-release-state.mjs "$VERSION" 2>&1); then
  err "npm release ordering rejects $VERSION; no repository or tag mutation was attempted."
fi
if printf '%s\n' "$NPM_GUARD_OUTPUT" | grep -qx 'already_published=true'; then
  err "$VERSION is already published to npm for $PACKAGE_NAME. Choose a higher version."
fi
printf '%s\n' "$NPM_GUARD_OUTPUT" | grep -qx 'already_published=false' || \
  err "npm release ordering returned an invalid result for $VERSION."
ok "npm channel ordering permits $PACKAGE_NAME@$VERSION."

# When resuming mid-flow, look up state we would have captured earlier.
PR_NUMBER=""
MERGE_SHA=""
if [[ "$FROM_STEP" -ge 6 && "$FROM_STEP" -le 7 ]]; then
  PR_NUMBER=$(gh pr list --repo "$REPO" --base main --head "$RELEASE_BRANCH" \
    --state open --json number --jq '.[0].number' 2>/dev/null || true)
  [[ -z "$PR_NUMBER" || "$PR_NUMBER" == "null" ]] && \
    err "Resuming from step $FROM_STEP but no open PR found from $RELEASE_BRANCH → main. Has it already been merged? Use --from-step 8."
  echo "  Resuming: found PR #$PR_NUMBER"
fi
if [[ "$FROM_STEP" -eq 8 ]]; then
  MERGE_SHA=$(gh pr list --repo "$REPO" --base main --head "$RELEASE_BRANCH" \
    --state merged --json mergeCommit --jq '.[0].mergeCommit.oid' 2>/dev/null || true)
  [[ -z "$MERGE_SHA" || "$MERGE_SHA" == "null" ]] && \
    err "Resuming from step 8 but could not find merge commit for $RELEASE_BRANCH → main. Has the PR been merged? Check https://github.com/$REPO manually."
  [[ "$MERGE_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || \
    err "Resuming from step 8 returned an invalid merge commit SHA: $MERGE_SHA"
  echo "  Resuming: found merge commit $MERGE_SHA"
fi

# ─── STEP 0: Clean state and main sync ───────────────────────────────────────
if run_step 0; then
  step "Step 0 — Clean state"

  [[ -n "$(git status --porcelain | grep -v '^??')" ]] && \
    err "Working tree is dirty. Commit or stash changes first."
  ok "Working tree is clean."

  [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]] && git checkout main
  git pull --ff-only origin main || err "main has diverged from origin/main. Resolve manually before running the release."
  ok "main is up to date."
else
  step "Step 0 — Clean state"; skip
fi

# ─── STEP 1: Guard ───────────────────────────────────────────────────────────
if run_step 1; then
  step "Step 1 — Guard: check v$VERSION is available"
  git fetch --tags

  git rev-parse --verify "refs/tags/v$VERSION" >/dev/null 2>&1 && \
    err "Tag v$VERSION already exists. Choose a higher version. Never delete tags on a public package."
  ok "Git tag v$VERSION is free."

  ok "npm $PACKAGE_NAME@$VERSION is free and channel ordering is monotonic."
else
  step "Step 1 — Guard"; skip
fi

# ─── STEP 2: Release branch ──────────────────────────────────────────────────
if run_step 2; then
  step "Step 2 — Create release branch"
  git fetch origin "$RELEASE_BRANCH" >/dev/null 2>&1 || true
  if git rev-parse --verify "$RELEASE_BRANCH" >/dev/null 2>&1 || \
     git ls-remote --exit-code --heads origin "$RELEASE_BRANCH" >/dev/null 2>&1; then
    err "Branch $RELEASE_BRANCH already exists locally or on origin. Delete it or choose a different version."
  fi
  git checkout -b "$RELEASE_BRANCH"
  ok "On branch $RELEASE_BRANCH."
else
  step "Step 2 — Create release branch"; skip
  # Steps 8+ don't need the release branch (it's deleted after Step 7 merge)
  if [[ "$FROM_STEP" -le 7 ]]; then
    git checkout "$RELEASE_BRANCH" 2>/dev/null || \
      git checkout -b "$RELEASE_BRANCH" "origin/$RELEASE_BRANCH" 2>/dev/null || \
      err "Cannot resume: branch $RELEASE_BRANCH not found locally or on origin. Run without --from-step to start fresh."
  fi
fi

# ─── STEP 3: Bump version files and changelog ────────────────────────────────
if run_step 3; then
  step "Step 3 — Bump version files and CHANGELOG.md to $VERSION"

  VERSION="$VERSION" node <<'NODE'
  const fs = require('node:fs');
  const path = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  pkg.version = process.env.VERSION;
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
NODE
  ok "package.json → $VERSION"

  VERSION="$VERSION" node <<'NODE'
  const fs = require('fs');
  const p = 'CHANGELOG.md';
  const version = process.env.VERSION;
  const changelog = fs.readFileSync(p, 'utf8');
  const hasBlock = changelog
    .split(/\r?\n/)
    .some(
      (line) =>
        line === `## ${version}` ||
        line === `## [${version}]` ||
        line.startsWith(`## ${version} `) ||
        line.startsWith(`## [${version}] `)
    );

  if (!hasBlock) {
    const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
    const lines = changelog.split(/\r?\n/);
    const headingIndex = lines.findIndex((line) => line.startsWith('# '));
    if (headingIndex === -1) {
      throw new Error('CHANGELOG.md top-level heading not found');
    }
    lines.splice(
      headingIndex + 1,
      0,
      '',
      `## ${version}`,
      '',
      '### Patch Changes',
      '',
      `- Manual release v${version}.`
    );
    fs.writeFileSync(p, lines.join(eol));
  }
NODE
  ok "CHANGELOG.md includes $VERSION release block."

  V1=$(node -p "require('./package.json').version")
  [[ "$V1" != "$VERSION" ]] && \
    err "Version mismatch after bump! package.json=$V1"
  ok "package.json verified at $VERSION."
else
  step "Step 3 — Bump version files and changelog"; skip
fi

# ─── STEP 4: Commit and push ─────────────────────────────────────────────────
if run_step 4; then
  step "Step 4 — Commit and push"
  git add package.json CHANGELOG.md
  if git diff --cached --quiet; then
    ok "No staged changes to commit; skipping git commit."
  else
    git commit -s -m "chore: bump version to $VERSION"
  fi
  git push -u origin "$RELEASE_BRANCH"
  ok "Pushed $RELEASE_BRANCH."
else
  step "Step 4 — Commit and push"; skip
fi

# ─── STEP 5: Open PR to main ─────────────────────────────────────────────────
if run_step 5; then
  step "Step 5 — Open PR targeting main"
  PR_URL=$(gh pr create \
    --repo "$REPO" \
    --base main \
    --title "chore: release v$VERSION" \
    --body "Version bump to $VERSION.")
  PR_NUMBER="${PR_URL##*/}"
  if [[ -z "$PR_NUMBER" || ! "$PR_NUMBER" =~ ^[0-9]+$ || -z "$PR_URL" ]]; then
    echo "Raw gh pr create output:" >&2
    echo "$PR_URL" >&2
    err "Failed to parse PR number/url from gh output."
  fi
  ok "PR #$PR_NUMBER created: $PR_URL"
else
  step "Step 5 — Open PR targeting main"; skip
fi

# ─── STEP 6: Wait for CI ─────────────────────────────────────────────────────
if run_step 6; then
  step "Step 6 — Wait for CI"
  if gh pr checks "$PR_NUMBER" --repo "$REPO" --watch; then
    ok "CI green."
  else
    if CHECK_COUNT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json statusCheckRollup --jq '.statusCheckRollup | length' 2>/dev/null); then
      if [[ "$CHECK_COUNT" -eq 0 ]]; then
        echo "  (No CI checks configured — skipping.)"
      else
        err "CI checks did not pass ($CHECK_COUNT configured). Inspect the PR and rerun with --from-step 6 when resolved."
      fi
    else
      err "Failed to query CI checks for PR #$PR_NUMBER. Verify GitHub CLI auth/network and rerun with --from-step 6 when resolved."
    fi
  fi
else
  step "Step 6 — Wait for CI"; skip
fi

# ─── STEP 7: Merge release PR ────────────────────────────────────────────────
if run_step 7; then
  step "Step 7 — Merge release PR #$PR_NUMBER"
  gh pr merge "$PR_NUMBER" --repo "$REPO" --merge --delete-branch
  MERGE_SHA=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid')
  [[ -z "$MERGE_SHA" || "$MERGE_SHA" == "null" ]] && \
    err "Could not determine merge commit SHA for PR #$PR_NUMBER. Check https://github.com/$REPO/pull/$PR_NUMBER."
  [[ "$MERGE_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || \
    err "GitHub returned an invalid merge commit SHA for PR #$PR_NUMBER: $MERGE_SHA"
  ok "PR #$PR_NUMBER merged to main (commit $MERGE_SHA)."
else
  step "Step 7 — Merge release PR"; skip
fi

# ─── STEP 8: Tag merge commit and wait for draft release ────────────────────
if run_step 8; then
  step "Step 8 — Tag merge commit and wait for draft GitHub release"

  # Use the exact merge commit SHA (not main HEAD, which may advance before we tag it).
  [[ -z "$MERGE_SHA" || "$MERGE_SHA" == "null" ]] && \
    err "MERGE_SHA not set — internal error. Re-run from step 7."
  [[ "$MERGE_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || \
    err "MERGE_SHA is not a valid commit SHA: $MERGE_SHA"
  MERGE_SHA=$(printf '%s' "$MERGE_SHA" | tr '[:upper:]' '[:lower:]')
  MAX_WAIT=${PUBLISH_MAX_WAIT:-900}
  [[ "$MAX_WAIT" =~ ^[0-9]+$ ]] || \
    err "PUBLISH_MAX_WAIT must be a non-negative integer in seconds (got: $MAX_WAIT)."
  NORMALIZED_MAX_WAIT=$MAX_WAIT
  while [[ "$NORMALIZED_MAX_WAIT" == 0* && "${#NORMALIZED_MAX_WAIT}" -gt 1 ]]; do
    NORMALIZED_MAX_WAIT=${NORMALIZED_MAX_WAIT#0}
  done
  MAX_WAIT_LIMIT="9223372036854775807"
  # Equal-width decimal strings need lexical comparison before arithmetic.
  # shellcheck disable=SC2071
  if [[ "${#NORMALIZED_MAX_WAIT}" -gt 19 ]] || \
    { [[ "${#NORMALIZED_MAX_WAIT}" -eq 19 ]] && [[ "$NORMALIZED_MAX_WAIT" > "$MAX_WAIT_LIMIT" ]]; }; then
    err "PUBLISH_MAX_WAIT must be a non-negative integer in seconds (got: $MAX_WAIT)."
  fi
  MAX_WAIT=$((10#$NORMALIZED_MAX_WAIT))

  TAG="v$VERSION"
  git fetch --no-tags origin main || \
    err "Failed to fetch origin/main before creating $TAG."
  git merge-base --is-ancestor "$MERGE_SHA" origin/main || \
    err "Merge commit $MERGE_SHA is not reachable from origin/main; refusing to tag it."
  MERGED_PACKAGE_VERSION=$(commit_json_version "$MERGE_SHA" "package.json") || \
    err "Could not read package.json version from merge commit $MERGE_SHA."
  [[ "$MERGED_PACKAGE_VERSION" == "$VERSION" ]] || \
    err "Merge commit $MERGE_SHA has an inconsistent package version (package=$MERGED_PACKAGE_VERSION; expected $VERSION); refusing to create $TAG."
  MERGED_CHANGELOG=$(git show "$MERGE_SHA:CHANGELOG.md") || \
    err "Could not read CHANGELOG.md from merge commit $MERGE_SHA."
  CHANGELOG_BLOCK=$(printf '%s\n' "$MERGED_CHANGELOG" | awk -v version="$VERSION" '
    $0 == "## " version || $0 == "## [" version "]" ||
    index($0, "## " version " ") == 1 || index($0, "## [" version "] ") == 1 {
      found=1
      next
    }
    found && /^## / { exit }
    found { print }
  ')
  [[ -n "$(printf '%s' "$CHANGELOG_BLOCK" | tr -d '[:space:]')" ]] || \
    err "Merge commit $MERGE_SHA has no nonempty CHANGELOG.md block for $VERSION; refusing to create $TAG."

  REMOTE_TAG_REFS=$(remote_tag_refs "$TAG") || \
    err "Failed to inspect $TAG on origin."
  REMOTE_TAG_OBJECT=$(printf '%s\n' "$REMOTE_TAG_REFS" | tag_object_from_refs "$TAG")
  REMOTE_TAG_TARGET=$(printf '%s\n' "$REMOTE_TAG_REFS" | tag_target_from_refs "$TAG")
  REMOTE_TAG_PEELED=$(printf '%s\n' "$REMOTE_TAG_REFS" | tag_peeled_from_refs "$TAG")

  if [[ -n "$REMOTE_TAG_OBJECT" ]]; then
    [[ "$REMOTE_TAG_TARGET" == "$MERGE_SHA" ]] || \
      err "Remote tag $TAG points to $REMOTE_TAG_TARGET, not merge commit $MERGE_SHA. Never overwrite a public release tag."
    [[ -n "$REMOTE_TAG_PEELED" ]] || \
      err "Remote tag $TAG is not annotated. Never overwrite a public release tag."
  fi

  if [[ -z "$REMOTE_TAG_OBJECT" ]]; then
    NPM_STATUS=0
    NPM_OUT=$(npm view "$PACKAGE_NAME@$VERSION" version 2>&1) || NPM_STATUS=$?
    if [[ "$NPM_STATUS" -eq 0 ]]; then
      err "$VERSION is already published to npm for $PACKAGE_NAME, but origin has no $TAG tag; refusing to associate an existing artifact with a new release tag."
    elif ! printf '%s\n' "$NPM_OUT" | grep -qiE 'E404|404 Not Found'; then
      err "Failed to query npm for $PACKAGE_NAME@$VERSION before creating $TAG; verify registry access and retry."
    fi
  fi

  if ! git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
    if [[ -n "$REMOTE_TAG_OBJECT" ]]; then
      git fetch origin "refs/tags/$TAG:refs/tags/$TAG" || \
        err "Failed to fetch existing remote tag $TAG."
      ok "Fetched existing remote tag $TAG."
    else
      git tag -s -a "$TAG" "$MERGE_SHA" -m "Release $TAG" || \
        err "Failed to create signed annotated tag $TAG at $MERGE_SHA."
      ok "Created signed annotated tag $TAG at $MERGE_SHA."
    fi
  fi

  LOCAL_TAG_OBJECT=$(git rev-parse "refs/tags/$TAG") || \
    err "Could not resolve local tag $TAG after creation or fetch."
  LOCAL_TAG_TARGET=$(git rev-parse "refs/tags/$TAG^{commit}" 2>/dev/null) || \
    err "Local tag $TAG does not resolve to a commit."
  [[ "$LOCAL_TAG_TARGET" == "$MERGE_SHA" ]] || \
    err "Local tag $TAG points to $LOCAL_TAG_TARGET, not merge commit $MERGE_SHA. Never overwrite a release tag."
  [[ "$(git cat-file -t "refs/tags/$TAG")" == "tag" ]] || \
    err "Local tag $TAG is not annotated. Never overwrite a release tag."
  LOCAL_TAG_NAME=$(git cat-file -p "refs/tags/$TAG" | awk '$1 == "tag" { print $2; exit }') || \
    err "Could not inspect the embedded name of local tag $TAG."
  [[ "$LOCAL_TAG_NAME" == "$TAG" ]] || \
    err "Local tag ref $TAG contains a signed tag object naming $LOCAL_TAG_NAME. Never publish a tag name the signer did not authorize."
  git tag -v "$TAG" >/dev/null 2>&1 || \
    err "Could not verify the cryptographic signature on local tag $TAG. Never overwrite a release tag."

  if [[ -n "$REMOTE_TAG_OBJECT" && "$REMOTE_TAG_OBJECT" != "$LOCAL_TAG_OBJECT" ]]; then
    err "Local and remote $TAG tag objects differ. Never overwrite a public release tag."
  fi

  if [[ -z "$REMOTE_TAG_OBJECT" ]]; then
    git push origin "refs/tags/$TAG" || \
      err "Failed to push signed tag $TAG. Inspect origin for a conflicting tag before retrying."
    ok "Pushed signed tag $TAG."
  else
    ok "Remote tag $TAG already exists at the expected merge commit."
  fi

  REMOTE_TAG_REFS=$(remote_tag_refs "$TAG") || \
    err "Failed to verify $TAG on origin after the tag step."
  REMOTE_TAG_OBJECT=$(printf '%s\n' "$REMOTE_TAG_REFS" | tag_object_from_refs "$TAG")
  REMOTE_TAG_TARGET=$(printf '%s\n' "$REMOTE_TAG_REFS" | tag_target_from_refs "$TAG")
  REMOTE_TAG_PEELED=$(printf '%s\n' "$REMOTE_TAG_REFS" | tag_peeled_from_refs "$TAG")
  [[ -n "$REMOTE_TAG_OBJECT" && -n "$REMOTE_TAG_PEELED" ]] || \
    err "Remote tag $TAG is missing or is not annotated after the tag step."
  [[ "$REMOTE_TAG_TARGET" == "$MERGE_SHA" ]] || \
    err "Remote tag $TAG points to $REMOTE_TAG_TARGET after the tag step, expected $MERGE_SHA."
  [[ "$REMOTE_TAG_OBJECT" == "$LOCAL_TAG_OBJECT" ]] || \
    err "Remote tag $TAG does not match the verified local signed tag."

  echo "  Waiting for the tag-triggered publish.yml draft run for $TAG at commit $MERGE_SHA..."

  RUN_ID=""
  WAIT_SECS=0
  WAIT_START=$(monotonic_seconds) || err "Could not read the monotonic clock before waiting for publish.yml."
  while [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; do
    RUN_ID=$(gh run list --repo "$REPO" --workflow publish.yml --event push --limit 20 \
      --json databaseId,headSha,headBranch \
      --jq "map(select(.headSha == \"$MERGE_SHA\" and .headBranch == \"$TAG\")) | .[0].databaseId // empty" 2>/dev/null || true)
    [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] && break
    WAIT_NOW=$(monotonic_seconds) || err "Could not read the monotonic clock while waiting for publish.yml."
    WAIT_SECS=$((WAIT_NOW - WAIT_START))
    if [[ "$WAIT_SECS" -ge "$MAX_WAIT" ]]; then
      err "Tag-triggered publish.yml draft run for $TAG at $MERGE_SHA not found after ${MAX_WAIT}s. Check https://github.com/$REPO/actions manually."
    fi
    REMAINING_WAIT=$((MAX_WAIT - WAIT_SECS))
    SLEEP_SECS=5
    [[ "$REMAINING_WAIT" -lt "$SLEEP_SECS" ]] && SLEEP_SECS=$REMAINING_WAIT
    sleep "$SLEEP_SECS"
  done

  echo "  Watching run $RUN_ID..."
  gh run watch "$RUN_ID" --repo "$REPO" || true

  CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq '.conclusion')
  if [[ "$CONCLUSION" == "skipped" ]]; then
    err "publish.yml was skipped — inspect the tag and draft release before retrying."
  fi
  [[ "$CONCLUSION" != "success" ]] && \
    err "publish.yml $CONCLUSION. See https://github.com/$REPO/actions/runs/$RUN_ID"

  RELEASE_STATE=$(gh release view "$TAG" --repo "$REPO" \
    --json isDraft,isPrerelease,tagName \
    --jq '[.isDraft, .isPrerelease, .tagName] | @tsv') || \
    err "publish.yml succeeded but draft release $TAG was not found. Check https://github.com/$REPO/actions/runs/$RUN_ID."
  IFS=$'\t' read -r RELEASE_IS_DRAFT RELEASE_IS_PRERELEASE RELEASE_TAG_NAME <<< "$RELEASE_STATE"
  [[ "$RELEASE_IS_DRAFT" == "true" ]] || \
    err "GitHub release $TAG is not a draft; npm publication must require a manual draft-to-final transition."
  EXPECTED_PRERELEASE="false"
  [[ "$VERSION" == *-beta.* ]] && EXPECTED_PRERELEASE="true"
  [[ "$RELEASE_IS_PRERELEASE" == "$EXPECTED_PRERELEASE" ]] || \
    err "GitHub release $TAG prerelease flag is $RELEASE_IS_PRERELEASE, expected $EXPECTED_PRERELEASE."
  [[ "$RELEASE_TAG_NAME" == "$TAG" ]] || \
    err "GitHub draft release tag is $RELEASE_TAG_NAME, expected $TAG."

  NPM_STATUS=0
  NPM_OUT=$(npm view "$PACKAGE_NAME@$VERSION" version 2>&1) || NPM_STATUS=$?
  if [[ "$NPM_STATUS" -eq 0 ]]; then
    err "$PACKAGE_NAME@$VERSION was published before the GitHub draft was manually finalized."
  elif ! printf '%s\n' "$NPM_OUT" | grep -qiE 'E404|404 Not Found'; then
    err "Failed to verify that $PACKAGE_NAME@$VERSION remains unpublished while $TAG is a draft."
  fi

  FINAL_REMOTE_TAG_REFS=$(remote_tag_refs "$TAG") || \
    err "Failed to verify $TAG on origin after draft creation completed."
  FINAL_TAG_OBJECT=$(printf '%s\n' "$FINAL_REMOTE_TAG_REFS" | tag_object_from_refs "$TAG")
  FINAL_TAG_TARGET=$(printf '%s\n' "$FINAL_REMOTE_TAG_REFS" | tag_target_from_refs "$TAG")
  FINAL_TAG_PEELED=$(printf '%s\n' "$FINAL_REMOTE_TAG_REFS" | tag_peeled_from_refs "$TAG")
  if [[ -z "$FINAL_TAG_OBJECT" || -z "$FINAL_TAG_PEELED" || "$FINAL_TAG_TARGET" != "$MERGE_SHA" || "$FINAL_TAG_OBJECT" != "$LOCAL_TAG_OBJECT" ]]; then
    err "publish.yml succeeded but git tag $TAG does not resolve to merge commit $MERGE_SHA. Check https://github.com/$REPO/actions/runs/$RUN_ID."
  fi
  ok "Draft GitHub release $TAG is ready and $PACKAGE_NAME@$VERSION remains unpublished."
  echo "  Publish the draft manually in GitHub to trigger npm publication."
else
  step "Step 8 — Tag merge commit and wait for draft GitHub release"; skip
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓  Draft release v$VERSION is ready for manual publication"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
