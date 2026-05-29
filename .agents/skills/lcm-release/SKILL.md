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
bash .agents/skills/lcm-release/scripts/release.sh 0.4.2 --from-step 8  # re-watch publish.yml
```

The script handles everything end-to-end:

| Step | What it does |
|------|--------------|
| 0 | Checkout main, pull, verify clean |
| 1 | Guard: abort if tag or npm version already exists |
| 2 | Create `release/vX.Y.Z` branch from main |
| 3 | Bump all 3 version files, verify they all match |
| 4 | Commit and push |
| 5 | Open PR targeting `main` |
| 6 | Wait for CI (skips gracefully if no CI configured) |
| 7 | Merge with `--merge` (preserves commit SHA on main) |
| 8 | Wait for `publish.yml` to complete |

## Prerequisites

- All feature PRs for this release are merged into `main`
- `gh` CLI is authenticated
- You have a version number that is higher than any existing tag/npm release

## Key invariants

- **Never delete tags** on a public package — if a version is taken, pick a higher one
- **Release PRs target `main`**
- **Use `--merge`** (not squash) so the version bump SHA is preserved on main
- **All 3 version files must match**: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - Note: marketplace.json stores version at `.plugins[0].version`, not root

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Guard fails: tag exists | Version already tagged | Pick a higher version |
| Guard fails: npm version exists | Already published | Pick a higher version |
| publish.yml conclusion is `skipped` | Tag or npm version exists (race) | Pick a higher version; start over |
| main diverged from origin/main | Local branch was manually changed or cherry-picked | Reconcile local `main` with `origin/main`, then rerun |
| publish.yml conclusion is not `success` | Build/test/publish failed | Check the run URL printed by the script |

## Scripts

```
.agents/skills/lcm-release/scripts/release.sh       ← full end-to-end, supports --from-step N
```
