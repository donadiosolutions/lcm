---
name: lcm-release
description: Use when explicitly asked to cut or recover a manual LCM release. Not for ordinary version bumps or Changesets release-note/version PR work.
---

# Manual LCM release

## Directives

The helper ends at a **draft GitHub release, not npm publication**. Changesets
remains the normal release-note/version PR flow. Read repository/local rules first;
a maintainer reviews and publishes the draft manually. Only `release: published`
publishes npm; a tag-triggered run must leave npm unpublished.

Never delete, move or overwrite release tags. Signed annotated tags must identify
the exact release PR merge commit, not a later main HEAD. Existing local/remote tag
objects must match exactly and verify cryptographically; valid one-sided tags are
recovered by fetching or pushing, not recreating them.

`package.json` is the version source; generated runtime/connector resources have no
independent version. Version-only edits leave `pnpm-lock.yaml` unchanged and stage
only `package.json` and `CHANGELOG.md`; the release changelog block must exist.
Build/check with pnpm; npm retains packing (`npm pack --ignore-scripts`) and trusted
publication. Stable releases update `latest` to the highest stable version; beta
releases update `beta`. Changesets' internal channel label on the open version PR
preserves manual beta/stable intent across main pushes until that PR merges/closes.

## Preflight

Require merged feature PRs, authenticated `gh`, an available signing key/agent and
trusted local signature verification. Choose canonical `MAJOR.MINOR.PATCH` or
`MAJOR.MINOR.PATCH-beta.N` above the corresponding npm dist-tag; other prereleases
and build metadata are unsupported. The helper rejects stale/published versions
before repository/tag mutation.

Use the [verified pnpm bootstrap](../../../docs/development.md) and
`pnpm install --frozen-lockfile`, not a global pnpm install. New unpublished tags
must contain `pnpm-lock.yaml`, `.npmrc`, `pnpm-workspace.yaml`, integrity-pinned
`packageManager` and bootstrap script. npm-only historical tags cannot be rebuilt;
already-published versions use the publication workflow's verification-only recovery,
not this helper's unpublished-version path.

## Procedure

Run at repository root:

```bash
bash .agents/skills/lcm-release/scripts/release.sh 0.5.0-beta.0
# Resume only after verifying earlier steps really completed:
bash .agents/skills/lcm-release/scripts/release.sh 0.5.0-beta.0 --from-step 8
```

| Step | Operation |
| --- | --- |
| 0 | Verify clean tracked state; check out main and fast-forward from origin |
| 1 | Reject existing release tag or published npm version |
| 2 | Create `release/v<version>` from main |
| 3 | Update/verify package version and changelog |
| 4 | Commit with signoff and push |
| 5 | Open release PR targeting main |
| 6 | Require successful CI; missing/unqueryable checks are not a pass |
| 7 | Revalidate exact-head checks, merge with expected-head guard and `--merge`, then confirm `MERGED` |
| 8 | Create/verify signed annotated tag at exact merge SHA, push if absent, verify successful tag-triggered draft creation and npm still unpublished |

`--from-step N` accepts 0–8. Resuming step 7 does not bypass admission. Step 8
resolves the merged `release/v<version>` PR; do not assume it discovers arbitrary
Changesets/version branch names. Review the resulting draft and publish manually.

## Recovery

| Failure | Action |
| --- | --- |
| Version taken; conflicting target/object; lightweight/unsigned/misnamed tag | Stop and inspect; never overwrite public history; choose a higher version when taken |
| Main diverged or merge SHA unreachable from origin/main | Preserve work and reconcile/verify selected release PR before retrying |
| CI absent/failing, query failure or head drift | Resolve admission/evidence and resume step 6; do not skip to an unchecked merge |
| `publish.yml` skipped or not successful | Inspect printed run URL, tag and draft before retrying step 8 |
| Invalid `PUBLISH_MAX_WAIT` | Use integer seconds 0–9223372036854775807; default 900 bounds draft-run discovery |
| Draft exists but npm already has the version | Stop and audit bypassed manual publication; do not retag |
| Published release restored to draft | Fix failed/cancelled publication and manually publish the restored draft again; existing npm versions are verified without republishing |
| Earlier failed public release blocks later release | Complete the earlier event successfully or withdraw it to draft before retrying |
| Earlier failure for the same republished tag | Expected retry history; same-tag failure is ignored while native FIFO concurrency still serializes different release runs |

GitHub publication is not transactional with npm: the release may briefly be public
before failed preflight or last-moment guards restore it to draft.
