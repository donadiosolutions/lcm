# Open Bug Remediation Design

## Objective

Resolve every GitHub issue labeled `bug` that is open in
`donadiosolutions/lcm` as of 2026-08-11. The initial inventory contains issues
#600 through #605. During canonical verification, #606 through #609 were
discovered and filed under the repository's mandatory bug-triage rule.
Completion requires each bug to have root-cause evidence, a
pre-fix failing regression, the smallest root-cause correction, complete
documentation and Changesets decisions, the repository's exact 100% coverage
gate, the mandated MoM review sequence, a merged signed-off PR, and verified
issue closure. The final audit must query GitHub again so bugs opened during
the work are not silently omitted.

## Initial Inventory and Disposition

| Issue | Disposition | Required outcome |
| --- | --- | --- |
| #600 | Reproducible Linux upgrade-compatibility defect | Add an authenticated one-time migration from v1.4.1 generated transient systemd units to the stable v1.4.2 unit identity. |
| #601 | Reproducible full-suite test-deadline defect | Give only the batch-compaction discovery regression a named 15-second test-owned deadline. |
| #602 | Reproducible CLI help-precedence defect | Resolve known-command help before Commander validates required operands or performs side effects. |
| #603 | Reproducible CLI compatibility defect | Accept occurrence-ordered repeatable `--tag` and `--tags` spellings for `lcm store`. |
| #604 | Reproducible Codex passive-capture data-loss defect | Normalize observed native Codex exec payloads into the existing bounded extractor semantics and make connector doctor prove functional coverage without writes. |
| #605 | Reproducible full-suite test-deadline defect | Give only the divergent-cache timestamp matrix a named 15-second test-owned deadline. |
| #606 | Reproducible full-suite test-deadline defect | Give only the two snapshot-validation reconciliation scenarios a named 15-second test-owned deadline. |
| #607 | Reproducible full-suite test-deadline defect | Give only the source-store re-fencing reconciliation scenario a named 15-second test-owned deadline. |
| #608 | Reproducible full-suite test-deadline defect | Give only the three snapshot-migration reconciliation scenarios a named 15-second test-owned deadline. |
| #609 | Reproducible full-suite test-deadline defect | Give only the instruction-cache divergence scenario a named 15-second test-owned deadline. |

The preliminary baseline is `origin/main` commit
`3f15ab9f4dcf04e5ce8d6a82eb1255e3e64dfcc5`. Every branch and closure must be
revalidated against the then-current protected `main` branch rather than this
initial SHA.

## Publication Boundaries and Order

Use four domain PRs. The split keeps the security-sensitive daemon migration,
test-only deadline contracts, CLI parsing changes, and passive-capture changes
independently reviewable.

1. `fix/600-legacy-daemon-upgrade-migration` — #600 plus this design document.
2. `fix/601-605-test-determinism` — #601, #605, and verification-discovered #606–#609.
3. `fix/602-603-store-help-tag-aliases` — #602 and #603.
4. `fix/604-codex-post-tool-capture` — #604.

The daemon, test-determinism, and CLI implementations may proceed in parallel
from one reviewed planning head with disjoint write sets. The daemon PR merges
first so the shared design and plan commits become reachable from `main`; the
test and CLI branches then sync with updated `main` before final verification.
The Codex-hook branch starts only after the CLI PR merges because both domains
necessarily modify `bin/lcm.ts` and `test/bin/lcm-run-cli.test.ts`; sequencing
them avoids an unsafe parallel write set. Use merge commits, never
rebase-merging or squashing.

## PR 1: Authenticated Legacy Daemon Migration (#600)

### Root cause

v1.4.1 launched Linux user daemons in generated transient units named
`lcm-daemon-<pid>-<timestamp>.service`. v1.4.2 derives a stable unit name from
the canonical state root and requires `LCM_SUPERVISOR_*` metadata. Stable-unit
probing cannot discover the old registration, while a live legacy PID and
responding endpoint correctly prevent an unauthenticated replacement. Explicit
restart and doctor therefore repeat `invalid-collision` or `not-running`
refusals without an authorized compatibility bridge.

The foreign-job classifier is a security invariant and must not be weakened.
A missing marker on the stable unit remains foreign and non-mutable.

### Design

Add a Linux/systemd-only legacy compatibility capability at the service-manager
boundary and admit mutation only in lifecycle code after all independent
identity signals agree.

Discovery must:

- enumerate only active user units matching the exact historical generated-name
  grammar;
- use bounded `systemctl --user` commands with the existing manager deadline;
- inspect exact candidate names without shell expansion, wildcard mutation, or
  process-wide signals;
- return bounded structured observations without raw manager output; and
- treat no candidate, multiple candidates, malformed output, timeout,
  permission failure, or state conflict as non-authority.

Authentication must require:

- one canonical state root and its exact owned `daemon.pid` and token paths;
- one live PID that equals the manager candidate's `MainPID`;
- process identity compatible with the historical LCM daemon command and
  expected entrypoint;
- ownership of the configured loopback listener by that PID;
- public health followed by token-authenticated health/diagnostics identifying
  the same PID and an older compatible LCM version; and
- an immediate manager re-probe showing the same exact unit, PID, active state,
  and absence of conflicting candidates.

Only explicit restart/doctor repair may consume this authority. Stop that exact
unit, prove it absent and its PID no longer live, then start the stable unit
through the normal supervisor path and require normal token-authenticated
endpoint admission. Preserve unresolved evidence on failure. Never broadly
delete credentials or stale registrations.

### Red tests

Before implementation, add and run tests that fail because no migration
capability exists:

- a complete positive v1.4.1-to-v1.4.2 restart/doctor migration proving the
  exact legacy stop and stable start;
- PID disagreement among manager, file, process, listener, and health;
- token or authenticated-diagnostics failure;
- wrong process command or entrypoint;
- wrong listener ownership;
- zero and multiple matching candidates;
- malformed, timed-out, permission-denied, and ambiguous manager responses;
- candidate disappearance or identity change at the pre-mutation re-probe;
- a foreign stable-name unit with no supervisor marker; and
- assertions that no `kill`, `pkill`, wildcard stop, or unrelated unit
  mutation occurs on every refusal.

Production and tests remain in the existing daemon lifecycle/supervisor
components unless an extracted module creates a materially clearer boundary.
If a production file is added, update `codecov.yml` and
`test/codecov-config.test.ts` atomically.

### User contract

Update `docs/daemon-restart-recovery.md` and the managed-service section of
`docs/configuration.md`. Explain the one-time authenticated migration, the
fail-closed ambiguity behavior, and why users should use `lcm doctor` or
`lcm daemon restart` instead of manual process or wildcard service-manager
commands. Add a patch Changeset.

## PR 2: Full-Suite Test Determinism (#601, #605, #606–#609)

### Root cause

#601's synchronous regression performs thirteen real discovery passes across
filesystem entries and WAL-backed SQLite state. #605's generated timestamp
matrix performs real worktree reconciliation and SQLite/cache validation. Both
inherit Vitest's five-second wall-clock default and pass immediately in focused
runs; under full parallel suite contention, individual cases have exceeded the
default without an assertion or production failure.

#606's two snapshot-validation reconciliation scenarios exercise the same
real filesystem/SQLite pipeline. In a solo canonical coverage run they took
5.983 and 6.080 seconds, timed out at the inherited five-second deadline, and
then passed together in isolation.

#607's source-store re-fencing scenario also performs real filesystem and
SQLite reconciliation. It timed out once under full-suite load, then passed in
3.40 seconds focused, 2.41 seconds under coverage, and on an exact full-suite
rerun.

#608's three snapshot-migration scenarios and #609's instruction-cache
divergence scenario likewise perform real filesystem/SQLite reconciliation.
They timed out in separate fresh coverage runs but passed immediately in
focused comparisons, isolating additional inherited-deadline defects.

These are test-owned deadline defects. The production algorithms, SQLite busy
timeout, global Vitest timeout, pool topology, and collection scope remain
unchanged.

### Red evidence and fix

The reported timed-out test is already the failing regression for each issue:

- `batch compaction discovery > handles absent, malformed, summarized, and
  replay discovery entries` for #601; and
- `worktree reconciliation > rejects divergent cache rows independently of
  '<description>' timestamp syntax` for #605; and
- `worktree reconciliation > validates journal component snapshots before
  merging` plus `accepts complete planned component snapshots before merging`
  for #606; and
- `worktree reconciliation > re-fences source stores when target merge markers
  already exist` for #607;
- the three snapshot-migration scenarios named in #608; and
- `worktree reconciliation > fails closed on instruction-cache divergence`
  for #609.

Preserve all scenarios and their assertions. Introduce a clearly named
`15_000` ms test-owned deadline constant or equivalent explicit option and
apply it only to those scenarios. This follows the established heavyweight
SQLite/filesystem test pattern and is not a global relaxation. Adding a
duplicate test would repeat the same expensive fixture without adding a new
behavioral assertion; the pre-fix timeout itself is the regression evidence.

Verify focused execution, at least twenty isolated repetitions of each target,
the complete suite, and the canonical coverage suite. When capacity permits,
run concurrent full-suite or coverage processes with isolated report paths to
exercise the contention regime.

This PR changes no user-facing behavior, requires no documentation update or
Changeset, and does not affect Codecov ownership.

## PR 3: Help Precedence and Store Tag Aliases (#602, #603)

### Root cause

Commander validates required operands before invoking command actions. The
current manual `opts.help` checks therefore cannot handle `store --help` and
other required-argument commands. A small argv preflight exists, but only for
top-level help and selected nested command groups.

`store` separately registers only `--tag`, while compatibility guidance and
the issue contract require both singular and plural spellings. `export --tags`
already has different comma-separated semantics, so no global argv rewrite is
safe.

### Design and red tests

Before implementation, add a matrix proving that every registered known
command with required positional arguments or option values currently fails
to render help before validation. Include memory commands, `events replay`,
`import-knowledge`, nested parent groups, top-level help, unknown commands,
options before/after help, and `--` option termination. Assert help exits zero,
prints the intended custom help page, and invokes no daemon, filesystem, or
command action.

Make the pre-parse resolver derive its known top-level command set from the
registered program or one authoritative catalog, ignore help after `--`, map
nested groups to their existing parent pages, and preserve unknown-command
behavior.

Add a failing parser/action regression invoking mixed
`--tag one --tags two --tag three` occurrences and asserting the `/store`
payload preserves all three values in command-line order. Register the two
spellings as one repeatable Commander option local to `store`; do not change
`export --tags`.

Update `src/cli-help.ts`, `docs/cli.md`, and the generated connector command
reference so usage, option descriptions, and examples agree. Add a patch
Changeset. Existing CLI component ownership remains correct.

## PR 4: Native Codex PostToolUse Capture (#604)

### Root cause

Codex's wildcard PostToolUse hook reaches `handlePostToolUse`, but the extractor
recognizes exact Claude-style names and `mcp__` calls. Native
`functions.exec`/`functions.exec_command` names and `cmd`/status fields are not
normalized. Successful calls produce no extracted event, so the handler exits
before scrubbing and sidecar persistence. Connector doctor only checks
installation structure and can report healthy while this functional path is
absent.

### Design

Create a small pure normalization boundary shared by the handler and connector
functional diagnostics. It must:

- recognize only observed native Codex exec names and bounded command fields;
- project exact observed failure status into the canonical boolean error
  marker without copying stdout, stderr, or the full response;
- reuse existing Bash event types, priorities, truncation, sensitive-path
  checks, feedback-loop exclusions, and event scrubbing;
- map structured file operations only when a real captured payload explicitly
  identifies an operation and path; and
- return no generic raw-command event for unknown payloads.

Do not parse arbitrary shell text into file events and do not persist raw tool
input/output. Any additional payload shape requires a captured fixture and its
own reviewed policy.

### Red tests and diagnostics

Before implementation, add table-driven integration tests that submit captured
native Codex exec payloads through `handlePostToolUse`, then assert one bounded,
scrubbed sidecar event with the expected type/category/priority and no response
or secret content. Cover both native exec names, `command` and `cmd`, success,
recognized failure status, irrelevant output, feedback-loop commands, malformed
inputs, and unknown tools.

Add structural connector tests requiring the exact wildcard PostToolUse command
instead of treating any LCM hook as sufficient. Add a no-write functional
doctor probe that sends fixed benign native fixtures through the pure
normalizer/extractor. Targeted connector doctor must distinguish installed
files from functional capture and fail actionably when installed capture is
non-functional. It must not write to the user's event sidecar.

Update `docs/passive-learning.md`, `docs/hook-protocol.md`, and
`docs/vscode-codex.md`. Document native coverage, no raw-output persistence,
and functional doctor behavior. Add a patch Changeset. Existing hook,
connector, and CLI Codecov ownership remains correct unless a production file
is added, in which case taxonomy files change atomically.

## Development Method

Every domain follows systematic debugging and strict red-green-refactor TDD:

1. Re-establish the exact baseline and root-cause data/control path.
2. Add the smallest observable regression and run it against unmodified
   production code, retaining the expected failure evidence.
3. Apply one root-cause correction without unrelated refactoring.
4. Run the focused regression and adjacent subsystem tests green.
5. Refactor only while the focused suite remains green.
6. Store non-obvious root causes, decisions, and solutions in LCM.

No new dependency is expected. If one becomes necessary, stop that worker,
evaluate the exact version with `socket package score`, pin it exactly, and
protect it with the lockfile integrity mechanism before adoption.

## MoM Coordination and Review

The current model coordinates and owns the plan. A `gpt-5.6-luna` subagent at
maximum effort reviews the implementation plan before code changes. Independent
exploration and implementation use `gpt-5.6-luna` at maximum effort with
disjoint branch/write scopes.

After focused and complete verification, each whole branch receives parallel
maximum-effort adversarial review from:

- `cortex-hq/zai-org-GLM-5.2`; and
- `xai/grok-4.5` using the required explicit model
  slug even when it is absent from the advertised model roster.

An `anthropic/claude-opus-5` subagent at medium effort then receives the branch,
the complete GLM report, and the complete Grok report and produces the
second-pass merge verdict. If the requested Grok route fails, retain the exact
tool failure as evidence; never silently substitute another reviewer.

Any finding returns to the appropriate Luna implementation worker. Review
feedback is evaluated through the receiving-code-review workflow; fixes receive
fresh regressions where applicable, focused and complete verification, and a
new review pass. No branch proceeds on a reviewer summary alone: inspect the
actual diff and evidence.

## Verification and Merge Gates

Each PR must satisfy:

- its pre-fix red evidence and post-fix focused regression;
- adjacent subsystem tests and repeated timing-sensitive cases where applicable;
- `npm run build`, `npm run typecheck`, and `npm run lint`;
- a fresh `npm run test:ci` showing exactly 100% lines, branches, functions,
  and statements for the complete collected scope and every per-file threshold;
- Codecov component tests, with complete exclusive ownership if production
  files were added or moved;
- complete user documentation and an explicit Changeset decision;
- no skipped tests, coverage exclusions, `v8 ignore`, lowered thresholds,
  narrowed collection, global timeout changes, flags, or report-only topology;
- commits GPG-signed and created with `--signoff`, with no agent attribution;
- all required GitHub checks terminal and successful; and
- all actionable review threads answered `Fixed in [commit hash].` and resolved.

PR bodies name the fixed issues so GitHub closes them on merge. Before every
merge, re-check whether the changeset is present and correct. Merge through a
merge commit only after the MoM second-pass verdict approves the exact head.

## Final Audit and Local Stability

After all four PRs merge:

1. Fetch `origin/main` and prove each merge/fixing commit is reachable.
2. Search GitHub again for every open issue labeled `bug`; investigate and
   include any issue opened during the workflow.
3. Confirm #600 through #609 are closed with merged-PR evidence.
4. In Codex, update the local main checkout exactly to `origin/main`, then run
   `npm run build`, `npm link`, `lcm doctor`, and `npm test`.
5. Run `lcm connectors install codex` followed by
   `lcm connectors doctor codex`.
6. Confirm the final worktree is clean and the installed package/connector
   reflect the protected branch.
7. Store durable decisions and root causes in LCM.
8. Mark the persistent goal complete only when repository, GitHub, coverage,
   review, package, daemon, and connector evidence all agree.
