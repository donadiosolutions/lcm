# Releasing

This repo uses Changesets to make npm releases reviewable.

## Normal development

For any pull request that changes user-facing behavior, a changeset should be
added before the work is considered ready to release:

```bash
npm run changeset
```

Choose the smallest appropriate bump:

- `patch`: fixes, docs-visible behavior changes, small compatibility work
- `minor`: new features or notable new behavior
- `major`: breaking changes

The generated markdown file in `.changeset/` should explain the release impact in a sentence or two.

PRs that only touch internal tooling or CI can skip a changeset when they do not need an npm release note.

## Who adds the changeset

Maintainers own release metadata.

- For internal PRs, the author can add the changeset directly.
- For external PRs, do not expect the contributor to know or run the Changesets
  workflow. The reviewer or merge maintainer should add the changeset before
  merge, or immediately afterward in a small follow-up PR.
- If a releasable PR lands without a changeset, create a catch-up changeset PR
  before running the release flow.

The practical rule is simple: if the change should appear in npm release notes,
make sure a maintainer gets a `.changeset/*.md` file onto `main`.

Release notes list merged pull requests rather than Changesets commit hashes.
PRs containing a major package Changeset, or whose conventional title includes
a breaking marker such as `feat!:` or `refactor(storage)!:`, appear under
**Breaking changes**. Conventional `feat:`/`feature:` titles select
**Features**, and `fix:` titles select **Fixes**; scopes such as `feat(cli):`
are supported. Every other included PR appears under **Extra notes**. Generated
version PRs are labeled `no-release-notes` automatically.

## Release flow

1. Merge releasable PRs to `main`.
2. Prepare the version PR:
   - For a normal stable release, let the `Version Packages` workflow open or
     update it automatically.
   - To start a beta series, manually run `Version Packages` with
     `channel=beta`. Changesets enters beta mode and starts at `beta.0`.
   - Further Changesets merged while beta mode is active update the version PR
     to the next `beta.N` automatically.
   - To finish a beta series, manually run `Version Packages` with
     `channel=stable`. Changesets exits beta mode and replaces the prerelease
     with the corresponding stable version.
   - A manual choice is stored on the open `changeset-release/main` PR as
     `release-channel:beta` or `release-channel:stable`. Later `main` pushes
     keep using that channel while Changesets updates the same PR. Multiple
     matching PRs or conflicting channel labels stop the workflow.
3. Review and queue the generated version PR with the repository's required
   merge-commit method (`gh pr merge PR --auto --merge`). The merge queue must
   retain `merge_method=MERGE`; squash and rebase methods discard commit
   ancestry that the release guard intentionally verifies. CI and the tag,
   publication, and recovery preflights all validate the queue rule GitHub
   applies to the repository default branch.
4. Create and push a signed annotated tag at that exact merge commit. Supported
   forms are `vX.Y.Z` and `vX.Y.Z-beta.N`; alpha, RC, other prerelease labels,
   build metadata, and numeric leading zeros are rejected.
5. Let the tag-triggered `Publish Package` run type-check, run the complete
   coverage suite, build, generate Codex Highlights, and create the GitHub
   release as a draft. It does not publish npm.
6. Review the draft without removing its workflow marker or Highlights section,
   then manually publish it in GitHub.
7. The resulting `release: published` event first runs a read-only trusted
   preflight without npm's OIDC permission. It repeats validation and tests and
   packs the exact package tarball. A separate OIDC job downloads that verified
   artifact with the runner-provided `gh` CLI, rechecks the release tag and npm
   ordering using workflow-revision tools, and publishes it. One trusted helper
   requires exactly one regular `.tgz`, resolves its absolute filesystem path,
   and invokes npm without a shell. Betas use `--tag beta`; stable releases use
   `--tag latest`.

GitHub changes the release from draft to public before it emits the
`release: published` event, so this gate cannot be fully transactional across
GitHub and npm. If trusted preflight or either last-moment publication guard
fails, or if the preflight or publish job is cancelled or fails before its
guard state is recorded, the workflow restores the GitHub release to draft.
There can therefore be a short public window before that restoration
completes. If npm was already published before a later step failed,
republishing the restored draft is safe: the retry detects the existing
immutable version, skips `npm publish`, and verifies its package version and
dist-tags. Verification reads five complete registry snapshots, waiting 2, 4,
8, and 16 seconds between attempts. Only incomplete propagation, such as a
missing exact version, missing list membership, or a valid older channel tag,
is retried. Malformed, conflicting, authorization, and unexpected process
results fail immediately.

For beta notes, the previous published release in the same `MAJOR.MINOR` series
is the comparison base, falling back to the latest stable release for the first
beta in a series. Stable notes always compare with the latest published stable
release, so a stable release following betas contains the complete change list
since the prior stable release. Drafts never establish a comparison boundary.

For an explicitly requested manual release created by the release helper, the
helper also owns recovery of the tag step. The command below looks up the merged
PR by the helper-created `release/vX.Y.Z` branch, so it does not apply to a
Changesets `Version Packages` PR or another manually named branch:

```bash
bash .agents/skills/lcm-release/scripts/release.sh 1.2.3 --from-step 8
```

Step 8 checks that the merge commit is reachable from `origin/main`, creates a
signed annotated tag when no local or remote tag exists, and pushes that exact
tag object. On retries it pushes a valid local-only tag or fetches a valid
remote-only tag; when both copies exist, their tag objects and peeled commits
must match. A conflicting, lightweight, or invalidly signed tag causes the
helper to stop; it never moves or overwrites a release tag. The helper then
selects the tag-triggered `publish.yml` run by tag name and merge commit SHA
without assuming `main` still points at that commit. It verifies the draft and
GitHub prerelease flag, confirms npm is still unpublished, and stops so a
maintainer can publish the draft manually.

Before any pull, branch, commit, or tag mutation, the manual helper applies the
same npm channel-ordering guard as the workflows. Manual helper versions may use stable `MAJOR.MINOR.PATCH` or beta
`MAJOR.MINOR.PATCH-beta.N` form. Other prerelease identifiers and build metadata
remain unsupported. The draft-run wait defaults to 900 seconds; override it with
`PUBLISH_MAX_WAIT=<non-negative integer seconds>` when needed.

Before running the manual helper, configure Git tag signing with an available
signing key and agent, and confirm that local signed-tag creation and signature
verification succeed with the trusted public key.

## External setup required

The repo-side files are not enough by themselves. A maintainer still needs to configure npm trusted publishing for this GitHub repository/workflow pair.

The version workflow keeps the repository-wide default token at no permissions
and grants write access only to its version job. That job needs `contents: write`
for GitHub-API version commits, `pull-requests: write` for the Changesets PR,
`issues: write` for its `no-release-notes` label, and `actions: read` for the
failed-manual-transition guard.

The version PR labeler creates the internal channel labels idempotently, keeps
only the resolved beta or stable label, and also applies `no-release-notes`.
After the PR merges or closes, normal pushes no longer find a persisted label;
`auto` then follows the committed `.changeset/pre.json` state.

Recommended external setup:

1. Configure npm trusted publishing for this package:
   - Package: `@donadiosolutions/lcm`
   - Publisher: GitHub Actions
   - Organization or user: `donadiosolutions`
   - Repository: `lcm`
   - Workflow filename: `publish.yml`
   - Environment name: `npm-publish`
   - CLI equivalent:
     ```bash
     npm trust github @donadiosolutions/lcm \
       --repo donadiosolutions/lcm \
       --file publish.yml \
       --env npm-publish
     ```
2. Keep the repository `OPENAI_API_KEY` secret configured. Draft release
   Highlights use the same secret as the Codex issue-labeling workflow.
3. Optionally add required reviewers to the GitHub Environment named `npm-publish`

When configuring npm trusted publishing, register the GitHub workflow using the exact workflow filename in this repo: `.github/workflows/publish.yml`.

For an ordinary failed publication, rerun the failed release-event workflow with
its original event payload. When publication preflight or the publish job
restores a release to draft, fix the failure and manually publish the draft
again. An earlier failed release run for another tag must either be followed by
a successful release or recovery run for that tag, or remain withdrawn as a
draft before later releases proceed. An earlier failed attempt for the same tag
does not block its retry.

Use the manual immutable-release recovery path only when all of these conditions
hold:

- the protected workflow-created GitHub Release is already public and immutable,
  so the workflow cannot restore it to draft;
- the canonical signed annotated tag still targets the release commit, that
  commit is reachable from `main`, the package version and changelog match, and
  the release retains its protected draft marker and Highlights;
- npm trusted publishing for the `npm-publish` environment is configured, and
  the requested npm version is either absent or already published with the
  expected package version and channel-safe dist-tags; and
- every failed publication for an earlier, different public tag has been
  recovered successfully or its release has been withdrawn to draft.

Dispatch the workflow from protected `main`, never another ref:

```bash
gh workflow run publish.yml \
  --repo donadiosolutions/lcm \
  --ref main \
  -f tag=v1.4.2
```

The read-only recovery preflight checks out trusted helpers from the exact
protected commit that defines the workflow and checks out the verified tag in a
separate directory. It builds, tests, and packs that tag before uploading a
short-lived artifact. The `npm-publish` job receives OIDC permission but never
checks out or executes tagged package code; it revalidates the tag and npm
ordering before downloading and publishing the artifact.

Recovery is idempotent. If npm already contains the version, both jobs verify
the published package and dist-tags without rebuilding, repacking, downloading,
or republishing it. A successful recovery run supersedes the earlier failed
release run for that same canonical tag in future publication-history checks.
Failed recovery runs do not create blockers for unrelated tags, although the
original unresolved release failure continues to block them.

The recovery path does not create, edit, withdraw, replace, or delete the GitHub
Release or tag, and it cannot bypass the initial protected
draft-to-published transition. Any identity, ancestry, history, ordering,
artifact, or npm-verification failure stops without mutating those immutable
objects. Inspect npm and the workflow run before retrying; after fixing the
trusted workflow on `main`, invoke the same command again.
