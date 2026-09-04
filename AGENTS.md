# Repository Instructions

- Read [AGENTS.local.md](./AGENTS.local.md) if present.
  - Statements in this local file should override any project instruction.
  - The file is intentionally gitignored. Keep it that way.
- See [WORKFLOW.md](./WORKFLOW.md) for the full development workflow.

## Test Coverage Approval Gate

- Maintain 100% line, branch, function, and statement coverage for every executable production TypeScript file matched by `bin/**/*.ts`, `installer/**/*.ts`, and `src/**/*.ts`.
- A change must not be approved, merged, or released unless a fresh `pnpm run test:ci` reports 100% lines, 100% branches, 100% functions, and 100% statements and passes the per-file threshold for the complete collected scope.
- For local development and pre-push verification, run only the tests relevant to the code being changed and its direct integration boundaries. If the impact is uncertain, err on the side of caution and widen the local test scope before pushing. Do not run unrelated local suites solely to duplicate the complete CI run; rely on CI to exercise the complete collected scope and enforce the 100% coverage gate.
- Do not use coverage exclusions, `v8 ignore` directives, skipped tests, or untested production wrappers to satisfy the gate. Cover behavior through observable public seams and deterministic failure injection.

## Codecov Components Maintenance

- Update `codecov.yml` and `test/codecov-config.test.ts` atomically whenever production TypeScript, features, or components are added, removed, moved, materially changed, or otherwise make classification stale.
- Require complete exclusive ownership and accurate stable IDs/names/paths: every covered production TypeScript file belongs to exactly one component.
- Do not freeze the taxonomy at its current count; intentional additions/removals must update the literal map and count atomically.
- Forbid Codecov flags, statuses, ignore/coverage exclusions, report-only runs, or reporting-topology changes without an explicit design change.
- Preserve the existing 100% line, branch, function, and statement gate enforced by a fresh `pnpm run test:ci` over the complete collected scope.

## PR Review And Merge

- Before merging a PR, check whether it changes user-facing behavior or should appear in npm release notes.
- If yes, make sure a maintainer adds a `.changeset/*.md` file before merge or immediately after in a follow-up PR.
- Do not expect external contributors to know or run the Changesets workflow.
- Use the smallest appropriate bump:
  - `patch`: fixes, compatibility work, docs-visible behavior changes
  - `minor`: new features or notable new behavior
  - `major`: breaking changes
- Treat a PR as not release-ready until the changeset question has been answered.

## Local Environment Stability

After merging a feature PR, serialize global environment changes with the
Environment Coordinator. That owner alone performs the following workflow;
implementation agents must not mutate the globally installed LCM. Choose the
native connector for the active agent and do not run both integrations unless
explicitly requested.

In the primary worktree, preserve unrelated changes, fetch `origin/main`, and
fast-forward clean `main` to the verified merged commit. Bootstrap pnpm as
shown in [docs/development.md](docs/development.md), then rebuild and install
the exact package artifact:

```bash
pnpm install --frozen-lockfile
pnpm run build
mkdir -p .superpowers/packages
lcm_package_dir="$(mktemp -d "$PWD/.superpowers/packages/run.XXXXXXXX")"
npm pack --ignore-scripts --pack-destination "$lcm_package_dir"
lcm_package_name="$(node -p 'require("./package.json").name.replace(/^@/, "").replace("/", "-") + "-" + require("./package.json").version + ".tgz"')"
lcm_tarball="$lcm_package_dir/$lcm_package_name"
npm install -g "$lcm_tarball" --ignore-scripts
# Verify the installed package version and contents against this exact tarball.
lcm install
lcm doctor # must show 0 failures
pnpm run test # must pass
```

Do not use `npm link` or `pnpm link --global`: installed LCM must be an
independent copy of the reviewed package artifact.

Then sync the agent native hook connector, where `<agent>` is one of `claude` or `codex`:

```bash
lcm connectors install <agent>
lcm connectors doctor <agent>
```

If anything fails, fix it before starting the next feature. A broken local env wastes time on every subsequent session (stale dist, wrong binary, hook errors, or mismatched native connector state).

## Documentation Requirements

All changes that affect user-facing behavior must include complete documentation in the `docs/` folder. This includes new features, configuration changes, CLI commands, hook additions, and API changes. Documentation should be written for end users, not developers — explain what it does, how to use it, and any configuration options.

## Coding Style

- **Prefer pure functions.** Functions should return their results rather than accumulating state on an object. Avoid mutable side-effect patterns (e.g., shared counters on a class instance) when a return value works just as well.

## Bug Triage During Investigation

When you stumble across a bug while working on something else, **stop and file a GitHub issue immediately** before continuing:

```bash
gh issue create \
  --repo donadiosolutions/lcm \
  --title "<Short description of bug>" \
  --body-file - <<'EOF'
**Observed behavior:** <what you saw>

**Expected behavior:** <what should happen>

**Root cause:** <if known>

**How to reproduce:** <steps or code snippet>

**Environment:**
- Agent: <agent name and version>
- Connector: <CLI or MCP>
- OS: <OS name and version>
EOF
```

Then carry on with the original task. This ensures bugs are tracked and can be assigned to another agent without holding up the current work.

## Release Process

Release metadata uses Changesets; see `RELEASING.md` and `WORKFLOW.md` for the normal release-note and version PR flow. Use `.agents/skills/lcm-release/SKILL.md` when explicitly cutting or recovering a manual release.

See `SKILL.md` in the `lcm-release` skill for the full step table and failure modes.
