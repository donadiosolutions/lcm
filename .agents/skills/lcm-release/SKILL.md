---
name: lcm-release
description: "Use when the user says 'cut a release', 'release vX.Y.Z', 'publish a new version', or 'bump the version'. Covers the full release flow: version bump → PR to main → CI → merge → publish."
---

# lcm-release

Cut a versioned release of donadiosolutions/lcm. This is a **public npm package** — never delete or overwrite existing git tags.

> **Note on release flow:** Changesets remains the normal release-note and version PR workflow. Use this script only when explicitly cutting or recovering a manual release.

## Normal flow — use the script

Run `.agents/skills/lcm-release/scripts/release.sh` from the repo root:

```bash
bash .agents/skills/lcm-release/scripts/release.sh <version>
# e.g.
bash .agents/skills/lcm-release/scripts/release.sh 0.4.2
bash .agents/skills/lcm-release/scripts/release.sh 0.5.0-beta.0
```

**Resuming after a failure** — pass `--from-step N` to skip already-completed steps:

```bash
bash .agents/skills/lcm-release/scripts/release.sh 0.4.2 --from-step 8  # create/verify tag and re-watch draft creation
```

The script handles everything end-to-end:

| Step | What it does |
|------|--------------|
| 0 | Checkout main, pull, verify clean |
| 1 | Guard: abort if tag or npm version already exists |
| 2 | Create `release/vX.Y.Z` branch from main |
| 3 | Bump the package version, add `CHANGELOG.md` entry, and verify it |
| 4 | Commit and push |
| 5 | Open PR targeting `main` |
| 6 | Wait for CI (skips gracefully if no CI configured) |
| 7 | Merge with `--merge` (preserves commit SHA on main) |
| 8 | Create or verify the signed annotated stable or `beta.N` tag at the exact merge commit, push it if absent, wait for `publish.yml` to create the draft GitHub release, and verify npm is still unpublished |

After step 8 succeeds, review the draft on GitHub and publish it manually. The
`release: published` workflow event is the only path that publishes the package
to npm.

## Prerequisites

- Use the verified pnpm bootstrap described in [development guidance](../../../../docs/development.md) for development installs and commands. Install dependencies with `pnpm install --frozen-lockfile`; do not install pnpm globally.
- New unpublished release tags must contain `pnpm-lock.yaml`, `.npmrc`, `pnpm-workspace.yaml`, the integrity-pinned `packageManager`, and the bootstrap script. npm-only historical tags cannot be rebuilt; already published versions retain verification-only recovery before pnpm prerequisites.

- All feature PRs for this release are merged into `main`
- `gh` CLI is authenticated
- Git tag signing is configured with an available signing key and agent, and
  local signed-tag verification succeeds with the trusted public key
- You have either a canonical stable `MAJOR.MINOR.PATCH` or beta
  `MAJOR.MINOR.PATCH-beta.N` version that is higher than the corresponding npm
  dist-tag; alpha, RC, other prerelease identifiers, and build metadata are not
  supported

## Key invariants

- **Never delete tags** on a public package — if a version is taken, pick a higher one
- **Release tags are signed and annotated** and must resolve to the exact release PR merge commit
- **Step 8 is idempotent** for a valid one-sided tag by pushing the local copy or fetching the remote copy; when both copies exist, their signed tag object and expected commit must match exactly
- **Release PRs target `main`**
- **Use `--merge`** (not squash) so the version bump SHA is preserved on main
- **Version-only changes leave `pnpm-lock.yaml` unchanged**. Step 3 writes the validated version with Node; step 4 stages `package.json` and `CHANGELOG.md`.
- **npm owns distribution**: builds and checks use `pnpm run`, while packing stays `npm pack --ignore-scripts` and trusted publishing stays npm.
- **`package.json` is the package version source of truth**; generated runtime
  and native connector resources carry no independent release version
- **CHANGELOG.md must include the release version block** before `publish.yml` creates the draft
- **The tag-triggered run never publishes npm**; it must leave an action-created
  draft, and a maintainer must publish that draft to trigger npm
- **npm dist-tags are channel-safe**: beta releases update `beta`; stable releases
  update `latest`, which must remain the highest stable version
- **Changesets channel intent lives on the open version PR**: manual beta or
  stable runs apply one internal release-channel label that later main pushes
  reuse until the PR merges or closes
- **The helper checks npm channel ordering before mutation**: stale beta or
  stable requests stop before pulling, branching, committing, or tagging
- **GitHub publication is not transactional with npm**: GitHub briefly makes a
  release public before the event workflow can restore a failed preflight or
  last-moment guard to draft

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Guard fails: tag exists | Version already tagged | Pick a higher version |
| Guard fails: npm version exists | Already published | Pick a higher version |
| Local or remote tag targets another commit | The version was already tagged from different history | Stop; never move or overwrite the tag, and choose a higher version if it is public |
| Existing tag is lightweight, unsigned, or differs between local and origin | The tag does not satisfy the release-signing invariant | Stop and inspect it manually; never overwrite a public release tag |
| Merge commit is not reachable from `origin/main` | The wrong PR/SHA was selected or main has not updated | Verify the merged release PR before retrying step 8 |
| publish.yml conclusion is `skipped` | The tag-triggered draft job did not run | Inspect the tag and existing draft before retrying step 8 |
| `PUBLISH_MAX_WAIT` is invalid | The override is not a non-negative integer number of seconds within Bash's signed arithmetic range | Set it to `0` or a positive whole number no greater than `9223372036854775807`; the default is `900` |
| main diverged from origin/main | Local branch was manually changed or cherry-picked | Reconcile local `main` with `origin/main`, then rerun |
| publish.yml conclusion is not `success` | Validation, tests, Highlights generation, or draft creation failed | Check the run URL printed by the script |
| Draft exists but npm already has the version | Publication bypassed the required manual draft transition | Stop and audit the release; never move or overwrite the tag |
| Published release returns to draft | Trusted preflight or the publish job failed or was cancelled | Fix the workflow failure, then publish the restored draft manually again; an existing npm version is detected and verified without republishing |
| Earlier failed publication blocks a later release | The earlier release is still public and its run has not succeeded | Rerun the earlier event successfully, or withdraw its release to draft before retrying the later release |
| Republished restored draft has an earlier failed run for the same tag | Expected retry history | The same-tag failure is ignored; native FIFO concurrency still prevents overlap with every other release run |

## Scripts

```
.agents/skills/lcm-release/scripts/release.sh       ← full end-to-end, supports --from-step N
```
