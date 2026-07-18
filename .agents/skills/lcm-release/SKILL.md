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
```

**Resuming after a failure** — pass `--from-step N` to skip already-completed steps:

```bash
bash .agents/skills/lcm-release/scripts/release.sh 0.4.2 --from-step 8  # create/verify tag and re-watch publish.yml
```

The script handles everything end-to-end:

| Step | What it does |
|------|--------------|
| 0 | Checkout main, pull, verify clean |
| 1 | Guard: abort if tag or npm version already exists |
| 2 | Create `release/vX.Y.Z` branch from main |
| 3 | Bump all 3 version files, add `CHANGELOG.md` entry, verify versions match |
| 4 | Commit and push |
| 5 | Open PR targeting `main` |
| 6 | Wait for CI (skips gracefully if no CI configured) |
| 7 | Merge with `--merge` (preserves commit SHA on main) |
| 8 | Create or verify the signed annotated `vX.Y.Z` tag at the exact merge commit, push it if absent, then wait for the tag-triggered `publish.yml` run |

## Prerequisites

- All feature PRs for this release are merged into `main`
- `gh` CLI is authenticated
- You have a stable `MAJOR.MINOR.PATCH` version that is higher than any existing tag/npm release; prerelease and build-metadata versions are not supported by `publish.yml`

## Key invariants

- **Never delete tags** on a public package — if a version is taken, pick a higher one
- **Release tags are signed and annotated** and must resolve to the exact release PR merge commit
- **Step 8 is idempotent** only when local and remote tags have the same signed tag object and expected commit; any conflict aborts without overwriting the tag
- **Release PRs target `main`**
- **Use `--merge`** (not squash) so the version bump SHA is preserved on main
- **All 3 version files must match**: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - Note: marketplace.json stores version at `.plugins[0].version`, not root
- **CHANGELOG.md must include the release version block** before `publish.yml` publishes to npm

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Guard fails: tag exists | Version already tagged | Pick a higher version |
| Guard fails: npm version exists | Already published | Pick a higher version |
| Local or remote tag targets another commit | The version was already tagged from different history | Stop; never move or overwrite the tag, and choose a higher version if it is public |
| Existing tag is lightweight, unsigned, or differs between local and origin | The tag does not satisfy the release-signing invariant | Stop and inspect it manually; never overwrite a public release tag |
| Merge commit is not reachable from `origin/main` | The wrong PR/SHA was selected or main has not updated | Verify the merged release PR before retrying step 8 |
| publish.yml conclusion is `skipped` | Tag or npm version exists (race) | Pick a higher version; start over |
| `PUBLISH_MAX_WAIT` is invalid | The override is not a non-negative integer number of seconds | Set it to `0` or a positive whole number; the default is `900` |
| main diverged from origin/main | Local branch was manually changed or cherry-picked | Reconcile local `main` with `origin/main`, then rerun |
| publish.yml conclusion is not `success` | Build/test/publish failed | Check the run URL printed by the script |

## Scripts

```
.agents/skills/lcm-release/scripts/release.sh       ← full end-to-end, supports --from-step N
```
