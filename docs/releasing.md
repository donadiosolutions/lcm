# Stable and beta releases

LCM publishes stable and beta versions through GitHub Actions. The supported
version forms are:

- Stable: `1.5.0`, with Git tag `v1.5.0`
- Beta: `1.5.0-beta.0`, with Git tag `v1.5.0-beta.0`

Alpha, release-candidate, custom prerelease, build-metadata, and leading-zero
versions are rejected.

## Preparing versions

Changesets remains the source of package versions and changelog entries. Normal
stable version PRs are created automatically after Changesets reach `main`.

To begin a beta series, run the **Version Packages** workflow manually with the
`beta` channel and merge its version PR. The first version uses `beta.0`;
subsequent Changesets increment it automatically. To produce the stable version,
run the same workflow with the `stable` channel and merge the updated version
PR. A stable transition is accepted only while beta mode is active.

## Draft and publication gate

Push a signed annotated tag at the exact version-PR merge commit. The tag
workflow validates the tag, package and plugin versions, main ancestry,
changelog, tests, coverage, build, and plugin bundles. It generates a mandatory
Highlights section with Codex and creates a draft GitHub release whose remaining
non-empty sections are Breaking changes, Features, Fixes, and Extra notes.
Highlights use the repository's existing `OPENAI_API_KEY` secret, shared with the
Codex issue-labeling workflow.

Review the draft in GitHub and publish it manually. npm publication cannot run
from the tag event; it starts only from GitHub's `release: published` event and
requires the action-created draft marker and Highlights section. Do not remove
either while editing the draft.

The publication workflow separates trust domains. A read-only preflight without
npm OIDC permission verifies the release again, runs the complete checks, and
packs the package. The OIDC-enabled job checks out only trusted workflow tools,
downloads that verified tarball with the runner-provided `gh` CLI, revalidates
the signed tag and npm channel ordering, and publishes the tarball without
running package scripts.

GitHub makes a release public before sending the `release: published` event, so
the GitHub-to-npm transition is not fully transactional. A trusted-preflight or
publish-job failure restores the release to draft, although a short public
window can occur first. If npm publication completed before a later failure,
publishing the restored draft again remains safe: the workflow recognizes the
existing immutable package version, skips a duplicate publication, and repeats
the final package and dist-tag verification.

Beta packages publish to the `beta` npm dist-tag. Stable packages publish to
`latest`, and the workflow verifies that `latest` remains the highest stable
version. Publishing a beta therefore never changes what users receive from an
unqualified `npm install @donadiosolutions/lcm`.

Before publishing a beta, the workflow requires it to advance both the current
`beta` dist-tag and the stable `latest` boundary. This prevents a beta for an
older or already-stable version from moving the prerelease channel backward.
Malformed `beta` or `latest` values fail closed. Registry reads have a 60-second
process timeout and terminate the npm subprocess with `SIGTERM` when exceeded.

## Release-note ranges

Beta notes compare with the latest published release in the same `MAJOR.MINOR`
series. The first beta in a new series falls back to the latest stable release.
Stable notes always compare with the latest stable release, so the final release
contains every change already previewed across its betas. Draft releases are
ignored until they are manually published.

Every included commit must map to a merged `main` pull request. Major package
Changesets appear under Breaking changes; otherwise `enhancement` and `bug` PR
labels select Features and Fixes. All remaining PRs appear under Extra notes.
The workflow fails instead of substituting commit hashes when a commit has no PR.

Release publication runs use GitHub's native `queue: max` concurrency mode: up
to 100 runs wait in one global FIFO queue, so different release tags cannot race
npm dist-tag validation and mutation. Once a queued run starts, it fails closed
behind an earlier failed run for another tag unless a later run for that tag
succeeds or its release was withdrawn to draft. A republished restored draft
ignores its own tag's earlier failed attempt. Version-package runs use a
separate native FIFO queue and block behind any failed manual beta/stable
transition until that transition run succeeds on retry, preventing later
automatic work from silently overtaking it.

The version workflow grants no token permissions by default. Its sole job gets
only the permissions it needs: Actions read access for the prior-failure guard,
contents and pull-request write access for the GitHub-API Changesets commit and
PR, and issues write access for the `no-release-notes` label.
