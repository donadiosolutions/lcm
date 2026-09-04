# Development Workflow

This file contains repository-specific policy and overrides only. Use the applicable Superpowers workflows for implementation mechanics; where this file explicitly conflicts with them, this file wins.

## Planning artifacts

- Do not add design, spec, or implementation-plan documents to the repository by default. Use the relevant issue/PR body as the durable source of truth when one exists; workflow-local scratch may be used as needed. Create tracked documents only when the user asks for one.
- A docs-only spec PR is not a mandatory pre-implementation phase.

## Branch and PR policy

```text
ordinary feat/docs/fix branches → main
maintenance fix branches        → maintenance/<major>.<minor>.x
```

- Before branching, fetch the selected target and create `feat/TOPIC`, `docs/TOPIC`, or `fix/TOPIC` from its current remote head; do not branch from a stale local base.
- All work targeting a protected branch lands through a PR with a merge commit. Do not squash-merge, rebase-merge, force-push, or use administrator bypasses except for a documented emergency or one manifested by the maintainer.
- A maintenance target must already be protected and configured with its required checks before admission.
- Use separate PRs for independent changes. Dependent work waits for its upstream PR to merge, then starts from or rebases onto the updated target branch; do not base dependent work on an unmerged topic branch.
- The root/coordinator owns pushes, PR creation, and merges. Implementation subagents commit only.
- For user-requested implementation, the default integration path is: push → open PR → resolve failures/review findings until every required exact-head gate passes → merge. Do not stop to ask which integration method to use unless the user requested otherwise.
- Confirm the PR is `MERGED` before post-merge validation or dependent work begins.

## Admission and CI invariants

- Required protected reviews and exact-head checks are authoritative. Do not infer merge readiness from an aggregate `ci` success while another required check is still incomplete.
- Before changing external admission, read `docs/external-admission.md`. Preserve fail-closed exact-head CI+DCO admission and the rule that write-capable evaluation uses trusted workflow code only and never executes or consumes PR-controlled code, artifacts, or caches.
- CI dependency/image/database caches are initialization state, not reusable test state. Preserve exact dependency-cache validation, digest validation for cached images, a secret-free PostgreSQL template, and fresh run-scoped credentials/resources for each conformance leg.
- npm publishing remains on GitHub-hosted runners because trusted provenance does not accept self-hosted runners.

## Development toolchain

- Follow [Development](docs/development.md) to bootstrap the exact `packageManager` version and SHA-512 archive pin with `node scripts/bootstrap-pnpm.mjs`. Use a fresh private destination and prepend the returned absolute bin directory to `PATH`; do not install pnpm globally.
- Use `pnpm install --frozen-lockfile` for clean development and CI installs, `pnpm run` for scripts, and `pnpm exec` for installed development tools. Keep `pnpm-lock.yaml` authoritative and dependencies exact.
- Keep `.npmrc` and `pnpm-workspace.yaml` with the lockfile. Dependency build scripts are allowed only for `esbuild` and optional macOS `fsevents`; manager mismatches must fail without automatic manager downloads.
- npm owns consumer topology installs, package tarballs, registry ordering, and publication. Public installation remains `npm install -g`.
- After merge, coordinate with the Environment Coordinator before any global installed-LCM mutation. That owner alone builds through pnpm, packs and installs the exact npm tarball, verifies installed artifact identity, and runs installation/doctor/connector checks. Do not use global links to the development tree.

## Release flow

1. User-facing changes targeting `main` include the appropriate `.changeset/*.md` entry.
2. `changesets/action` creates or updates the version PR; manual `channel=beta` and `channel=stable` dispatches enter or exit beta mode.
3. After the version PR merges, create and push its exact signed annotated `vX.Y.Z` or `vX.Y.Z-beta.N` tag. Never move or overwrite a conflicting release tag.
4. The tag-triggered `publish.yml` validation creates a draft GitHub release. A maintainer reviews and publishes the draft manually.
5. npm publication happens only from the `release: published` path: beta releases update `beta`; stable releases update `latest`.
