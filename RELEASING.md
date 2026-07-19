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
PRs containing a major package Changeset appear under **Breaking changes**;
otherwise the `enhancement` and `bug` labels select **Features** and **Fixes**.
Every other included PR appears under **Extra notes**. Do not combine
`enhancement` and `bug` on one PR. Generated version PRs are labeled
`no-release-notes` automatically.

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
3. Review and merge the generated version PR.
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
   ordering using workflow-revision tools, and publishes it. Betas use
   `--tag beta`; stable releases use `--tag latest`.

GitHub changes the release from draft to public before it emits the
`release: published` event, so this gate cannot be fully transactional across
GitHub and npm. If trusted preflight or either last-moment publication guard
fails, or if the publish job fails before its guard state is recorded, the
workflow restores the GitHub release to draft. There can therefore be a short
public window before that restoration completes. If npm was already published
before a later step failed, republishing the restored draft is safe: the retry
detects the existing immutable version, skips `npm publish`, and verifies its
package version and dist-tags.

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

For recovery, rerun a failed tag-triggered draft run with its original event
payload. When publication preflight or the publish job restores a release to
draft, fix the failure and manually publish the draft again; an earlier failed
release run for another tag must either be followed by a successful run for that
tag or remain withdrawn as a draft before later releases proceed. An earlier
failed attempt for the same tag is treated as the history of that republished
draft and does not block its retry. If npm publication itself may have started,
inspect npm and the workflow run before changing GitHub state. There is no manual
dispatch path that can bypass the GitHub draft-to-published transition.
