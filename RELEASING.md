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

## Release flow

1. Merge releasable PRs to `main`
2. Let the `Version Packages` workflow open or update the release PR
3. Review the generated version bump and `CHANGELOG.md`
4. Merge the release PR to `main`
5. Create and push the matching signed annotated semver release tag, for example
   `vX.Y.Z`, at the exact release PR merge commit
6. Let the `Publish Package` workflow run automatically from that tag
7. Approve the workflow if a protected GitHub Environment is configured
8. Let the workflow:
   - install dependencies
   - run tests
   - publish to npm
   - create or update the GitHub release for the tag

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
without assuming `main` still points at that commit.

Manual helper versions must use stable `MAJOR.MINOR.PATCH` form because the
publish workflow does not accept prerelease or build-metadata tags. The
publication-run wait defaults to 900 seconds; override it with
`PUBLISH_MAX_WAIT=<non-negative integer seconds>` when needed.

Before running the manual helper, configure Git tag signing with an available
signing key and agent, and confirm that local signed-tag creation and signature
verification succeed with the trusted public key.

## External setup required

The repo-side files are not enough by themselves. A maintainer still needs to configure npm trusted publishing for this GitHub repository/workflow pair.

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
2. Optionally add required reviewers to the GitHub Environment named `npm-publish`
3. Confirm the repository label taxonomy used by `.github/release.yml`

When configuring npm trusted publishing, register the GitHub workflow using the exact workflow filename in this repo: `.github/workflows/publish.yml`.

The publish workflow also supports manual dispatch for recovery from a specific
`vX.Y.Z` tag. It will not publish from branch refs, and it fails if the tag
version does not match `package.json` or the tagged commit is not reachable from
`origin/main`.
