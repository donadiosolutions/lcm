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

A manual channel choice is persisted on the open `changeset-release/main`
version PR as exactly one internal `release-channel:beta` or
`release-channel:stable` label. Later pushes to `main` reuse that label when the
Changesets action updates the same PR, so unrelated changes cannot reset the
manual choice to automatic mode. Multiple open version PRs or conflicting
channel labels fail closed. When the version PR merges or closes, the lookup no
longer finds it and automatic runs again follow the prerelease state committed
in `.changeset/pre.json`.

After every protected-branch check and review passes on the exact version-PR
head, merge it directly with a merge commit (`gh pr merge PR --merge`). The
repository does not use a merge queue. Do not squash or rebase version PRs:
the merge commit and its maintenance and forward-port commits must remain in
`main` ancestry.

## Draft and publication gate

Push a signed annotated tag at the exact version-PR merge commit. The tag
workflow validates the tag, package version, main ancestry, changelog, tests,
coverage, build, generated npm runtime, and package contents. It generates a mandatory
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
packs the package, including the generated `dist/lcm.mjs` runtime and native
connector resources. The generated runtime is a release artifact and is not
committed to the repository. The OIDC-enabled job checks out only trusted workflow tools,
downloads that verified tarball with the runner-provided `gh` CLI, revalidates
the signed tag and npm channel ordering, and publishes the tarball without
running package scripts. The shared normal/recovery helper accepts exactly one
regular `.tgz`, resolves it to an absolute filesystem path, and invokes npm
without a shell.

GitHub makes a release public before sending the `release: published` event, so
the GitHub-to-npm transition is not fully transactional. A trusted-preflight or
publish-job failure or cancellation restores the release to draft, although a
short public window can occur first. If npm publication completed before a
later failure, publishing the restored draft again remains safe: the workflow
recognizes the existing immutable package version, skips a duplicate
publication, and repeats the final package and dist-tag verification. The final
verification takes five complete metadata snapshots with 2-, 4-, 8-, and
16-second delays. It retries only incomplete registry propagation: a missing
exact version, missing version-list membership, or a valid older expected
dist-tag. Malformed metadata, conflicting/newer tags, authorization failures,
and unexpected npm process results fail immediately.

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
Changesets and any conventional title with a breaking marker, such as `feat!:`
or `refactor(storage)!:`, appear under Breaking changes. Conventional
`feat:`/`feature:` titles select Features and `fix:` titles select Fixes;
scopes such as `feat(cli):` are supported. All remaining PRs appear under
Extra notes. The workflow fails instead of substituting commit hashes when a
commit has no PR.

Release publication runs use GitHub's native `queue: max` concurrency mode: up
to 100 runs wait in one global FIFO queue, so different release tags cannot race
npm dist-tag validation and mutation. Once a queued run starts, it fails closed
behind an earlier failed run for another tag unless a later run for that tag
succeeds or its release was withdrawn to draft. A republished restored draft
ignores its own tag's earlier failed attempt. Version-package runs use a
separate native FIFO queue and block behind any failed manual beta/stable
transition until that transition run succeeds on retry, preventing later
automatic work from silently overtaking it.

Each publication workflow run stores its direct event tag in the strict
`release-tag:TAG` run name. Completed-run recovery policy reads only that stored
name; it does not infer a tag from a branch or commit SHA. A failed historical
run with a canonical tag remains blocking until it is retried successfully or
its release is withdrawn to draft. An explicitly noncanonical stored tag is a
preflight-impossible attempt and is warned about and ignored. Missing or
malformed stored run provenance fails closed because the workflow cannot safely
associate it with an immutable release.

## Immutable published-release recovery

Normal npm publication starts from the GitHub `release: published` event. If
that run restores the release to draft, fix the failure and publish the same
draft again. Use the manual immutable-release recovery path only when the
workflow-created GitHub Release is already public and cannot be restored to
draft, its canonical signed annotated tag and protected marker remain intact,
and npm trusted publishing is configured for the `npm-publish` environment.

Dispatch recovery from protected `main`, never another ref:

```bash
gh workflow run publish.yml \
  --repo donadiosolutions/lcm \
  --ref main \
  -f tag=v1.4.2
```

The read-only recovery preflight first checks out the trusted default-branch
release policy. It validates the live marker and publication history before
checking out tagged code or executing any tagged package or npm code. It then
verifies the immutable tag, ancestry, package version, changelog, npm ordering,
tests, build, and package artifact. The OIDC job uses only trusted tools and the
verified tarball; it does not check out or execute tagged package code.

Recovery is idempotent. If npm already contains the version, the workflow
verifies the package and dist-tags without rebuilding, repacking, downloading,
or republishing it. A successful recovery supersedes the earlier failed
canonical run for that tag. Failed recovery runs do not block unrelated tags,
but the original unresolved release failure continues to do so.

The recovery path does not create, edit, withdraw, replace, or delete the
GitHub Release or tag. Any identity, ancestry, history, ordering, artifact, or
npm-verification failure stops without mutating those immutable objects.

The version workflow grants no token permissions by default. Its sole job gets
only the permissions it needs: Actions read access for the prior-failure guard,
contents and pull-request write access for the GitHub-API Changesets commit and
PR, and issues write access for the `no-release-notes` label.
