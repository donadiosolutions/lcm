# Developing LCM

LCM development uses pnpm for dependency installation and scripts. Node.js
22.12.0 or newer remains the runtime. npm remains responsible for consumer
installation, tarball creation, registry checks, and publication.

## Bootstrap the verified package manager

Run these commands from the repository root with Node and the system `tar`
available:

```bash
mkdir -p .superpowers/pnpm
pnpm_bootstrap_root="$(mktemp -d "$PWD/.superpowers/pnpm/run.XXXXXXXX")"
pnpm_bin="$(node scripts/bootstrap-pnpm.mjs --destination "$pnpm_bootstrap_root/verified")"
export PATH="$pnpm_bin:$PATH"
pnpm install --frozen-lockfile
```

`package.json` is the sole manager pin. Its `packageManager` field specifies
pnpm **10.34.5** and the SHA-512 digest of its registry archive:

```text
pnpm@10.34.5+sha512.a4ee05f2f73658255bd6a89859c065a45c28a57daefae2c893a168ee2b73168c37b91e83e57ea67654ad03f03031746430e8bce38e362e042605fb8abc80192e
```

The bootstrap downloads that exact archive, verifies its integrity before
extraction or execution, and checks the package identity and reported version.
Success prints only the absolute binary directory. The parent directory must
exist and the destination must **not** exist; allocate a new destination on
each bootstrap. Failures stop bootstrap and remove its newly created
destination. `.superpowers/` is ignored, so these local artifacts never enter
the package or repository history. Remove the owned bootstrap directory when
you no longer need that shell's pnpm installation.

No global pnpm installation is needed. `.npmrc` disables automatic package
manager downloads and requires the exact configured version, so a mismatched
pnpm fails instead of silently choosing another version. Keep the bootstrapped
bin directory at the front of `PATH` for nested scripts as well.

## Dependencies and scripts

`pnpm-lock.yaml` is authoritative. Clean development and CI installs use
`pnpm install --frozen-lockfile`, which refuses manifest/lockfile drift. Do not
recreate `package-lock.json`. `.npmrc` sets exact saves, isolated linking, and
pre/post script execution. `pnpm-workspace.yaml` scopes the workspace to the
root, retains the `read-yaml-file` override, and allows dependency build scripts
only for `esbuild` and optional macOS `fsevents`.

Before adding a dependency, assess its exact version and transitive findings
with `socket package score <ecosystem> <name>@<version> --json`. Add approved
dependencies with `pnpm add --save-exact <name>@<version>` (include `--save-dev`
for development tools), review the lockfile and integrity changes, and verify
a frozen install. Changesets version-only updates must leave the dependency
graph unchanged.

```bash
pnpm run build
pnpm exec vitest run test/scripts/source-installer.test.ts
pnpm run typecheck
pnpm run lint
pnpm run verify:consumer-topology
pnpm run update:patterns
```

`pnpm run build` also runs `postbuild`, which copies runtime assets. Use
`pnpm exec` for installed tools and `pnpm run` for package scripts.
`pnpm run update:patterns` regenerates the sensitive-pattern data from a source
checkout using the existing Node TypeScript invocation; it needs a Node
version that supports that invocation. It is not an installed-package command.

Run focused tests for changed code and its direct integration boundaries
locally. Fresh exact-head CI must pass `pnpm run test:ci` with 100% lines,
branches, functions, and statements for every collected production TypeScript
file. Do not exclude files or skip tests to meet that gate. PostgreSQL
integration files run only through `pnpm run test:postgresql`; see
[PostgreSQL development](../src/storage/postgresql/reference/postgresql-development.md)
for the isolated container prerequisites and lifecycle.

## Coordinated Bug campaigns

Use the repository's [triage-fix-all-bugs skill](triage-fix-all-bugs.md) to
coordinate triage, independent reviews, and merges for all currently open native
GitHub Bug issues. The guide explains invocation, prerequisites, progress reports,
and how follow-up Bugs remain outside the campaign's frozen scope.

## Codex Responses gateway fixtures

Gateway tests may provide the internal `_upstreamUrl` option to target a
private loopback fixture. That fixture URL takes precedence over the validated
`upstreamResponsesUrl`; when neither is present, route-specific `_upstreamUrls`
then provider defaults apply. This keeps tests isolated when normal config
resolution also supplies a provider endpoint. These options are internal test
seams and are not part of the public package configuration.

## Test scratch isolation

Vitest setup selects a private temporary parent whose canonical ancestor chain
has no `.git` marker. It checks the caller's temporary directory first, then
the platform fallbacks (`/var/tmp` and `/tmp` on POSIX; the configured Windows
temporary locations). A marker of any type, including an empty or malformed
`.git` directory, excludes that parent. For automatic candidates, probe,
realpath, and creation failures advance to the next finite candidate. An
explicit `LCM_TEST_VITEST_RUNTIME_ROOT_PARENT` or
`LCM_TEST_HARNESS_TMPDIR` must name a non-empty absolute path for the active
platform. Invalid or relative explicit values are rejected before filesystem
checks and never fall back. Invalid or relative automatic candidates are
skipped in favor of the next finite candidate.

Each run owns one mode-0700 root. Forked workers create a home directory and a
sibling temporary directory below that root before test modules load, and set
`TMPDIR`, `TMP`, and `TEMP` to the sibling. The PostgreSQL harness uses the
same selector and passes its selected parent to nested children through the
development-only `LCM_TEST_HARNESS_TMPDIR` handoff. Handoff paths are absolute
so allocation and nested authentication agree even when processes have
different working directories. Before that handoff is installed, the Vitest
global captures the finite original parent candidates in the internal
`LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS` snapshot. Nested harness authentication
uses the selected handoff and that preserved snapshot, so a worker's rewritten
`TMPDIR`, `TMP`, and `TEMP` cannot replace the parent's original authentication
boundary. Existing snapshots are preserved verbatim; malformed or missing
snapshots never trigger a nested recapture and safely degrade to the handoff
plus platform fallbacks. Cleanup removes only roots created by the current run.

Vitest config-time roots (`createVitestRunRoot` in `vitest.config.ts` and
`postgresqlVitestCacheDir` in `vitest.postgresql.config.ts`) are resolved before
setup files run, so cache, coverage, and JUnit output may remain below the
caller's temporary directory. They are never passed to
`resolveGitProjectAnchor`; `LCM_TEST_ARTIFACT_ROOT` retains its existing fresh
leaf rules. `cleanupOrphanedProjects` is scoped to the redirected temporary
directory and therefore does not sweep pre-existing orphans in the ambient
temporary root. On a host with a valid ambient `.git`, tests no longer share
that repository identity.

The consumer verifier builds through pnpm, then uses npm to pack and install
ordinary and conflicting consumers outside the repository configuration tree.
It verifies the package that npm users receive, including the Node CLI and
storage APIs.

## Install a built checkout

To run the checkout without changing your global installation, build it and
invoke `node dist/lcm.mjs ...`.

To install the built package, use an exact tarball rather than a global link:

```bash
pnpm run build
mkdir -p .superpowers/packages
lcm_package_dir="$(mktemp -d "$PWD/.superpowers/packages/run.XXXXXXXX")"
npm pack --ignore-scripts --pack-destination "$lcm_package_dir"
lcm_package_name="$(node -p 'require("./package.json").name.replace(/^@/, "").replace("/", "-") + "-" + require("./package.json").version + ".tgz"')"
lcm_tarball="$lcm_package_dir/$lcm_package_name"
npm install -g "$lcm_tarball" --ignore-scripts
```

The fresh directory holds the tarball from this build only. Keep it until
verification finishes. Verify the global package version and compare installed
package files against this tarball's contents before running `lcm install`,
`lcm doctor`, and the selected connector's install/doctor commands. A version
string alone does not establish artifact identity. npm's `--ignore-scripts`
keeps these artifact operations from triggering another build. npm publication
continues to use the protected release workflow described in
[Releasing](releasing.md).

For coordinated post-merge work, only the Environment Coordinator mutates the
global LCM installation or runs these environment checks. Implementation agents
hand off the merged commit and validation results to that owner. Do not use
`npm link` or `pnpm link --global` to point installed LCM into a worktree.

## Source-clone installer

`bash install.sh` clones or updates the source at `LCM_DIR` (default
`~/.lcm/plugin`, with legacy `LOSSLESS_CLAUDE_DIR` fallback). It bootstraps the
same verified pnpm pin into a fresh temporary directory, installs with
`--frozen-lockfile`, builds, and removes the temporary manager when it exits.
Node, Git, `tar`, and network access to the repository and registry are needed.

The installer writes its Node launcher to `~/.npm-global/bin/lcm`, adds that
location to the active shell profile, and runs `lcm install`. After the build,
it validates and wraps the bundled `dist/lcm.mjs` runtime declared by
`package.json`'s `bin.lcm`, so the source launcher follows the same entrypoint
as the packaged CLI. Bootstrap, installation, or build failure stops before
replacing the launcher. If an authenticated daemon was started from an older
source or intermediate entrypoint, adopting the canonical packaged runtime
identity may require one daemon restart the next time it is installed or used.
Use the tarball procedure above when you need an installed copy independent of
the checkout.
