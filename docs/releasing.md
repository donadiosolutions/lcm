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

Beta packages publish to the `beta` npm dist-tag. Stable packages publish to
`latest`, and the workflow verifies that `latest` remains the highest stable
version. Publishing a beta therefore never changes what users receive from an
unqualified `npm install @donadiosolutions/lcm`.

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
