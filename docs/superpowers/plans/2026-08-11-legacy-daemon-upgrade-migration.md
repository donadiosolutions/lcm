# Legacy Daemon Upgrade Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #600 by safely migrating one authenticated v1.4.1 generated Linux systemd unit to the stable managed unit used by v1.4.2.

**Architecture:** Keep stable-unit collision classification fail-closed. Add bounded systemd-only discovery and exact-stop capabilities to the supervisor, then let explicit restart authenticate a single legacy candidate through manager PID, owned state, process command/entrypoint, loopback listener, token-authenticated health/access, and an immediate pre-stop re-probe. Stable replacement is allowed only when the authenticated legacy daemon removes its own PID file during exact stop; LCM never mutates a remaining PID pathname after descriptor validation.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node.js 25.9.0, Linux `/proc`, systemd user manager, HTTP health/authentication, Git.

## Global Constraints

- In a fresh isolated worker workspace, resolve `REVIEWED_PLANNING_HEAD=$(git rev-parse --verify 'refs/lcm/planning/open-bugs-2026-08-11^{commit}')`, require `test "$(git rev-parse HEAD)" = "$REVIEWED_PLANNING_HEAD"`, persist it with `git update-ref refs/lcm/implementation-bases/issue-600-legacy-daemon "$REVIEWED_PLANNING_HEAD"`, and create branch `fix/600-legacy-daemon-upgrade-migration` from that exact SHA; never use a `codex/` prefix.
- Do not use, clean, stage, or modify the coordinator worktree or pre-existing files outside this branch.
- The compatibility path is Linux/systemd-only and may mutate state only during explicit restart/doctor repair.
- Historical name matching is discovery input, never ownership proof.
- Require exactly one candidate and agreement across every identity signal before mutation.
- Stop one exact unit name through argv-based `systemctl --user`; never use shell expansion, wildcard stop, `kill`, `pkill`, or broad cleanup.
- After exact legacy stop, treat PID-file disappearance as the only successful state transition. If any PID pathname remains, preserve it and refuse stable start; do not unlink a pathname after descriptor identity checks.
- When the PID file is missing before authentication, perform bounded strict legacy-unit discovery. Preserve ordinary absent startup only when discovery proves zero legacy candidates; any candidate or unavailable discovery refuses stable start.
- Preserve existing stable foreign-job, stale-config, ambiguous-manager, detached, credential, and publication fences.
- Add no dependency and preserve exact pins/lockfile integrity.
- Update user documentation and add one patch Changeset.
- Keep production changes in existing Codecov-owned daemon files; if a production file is added, update both taxonomy files atomically.
- GPG-sign every commit and include DCO `--signoff`.

---

### Task 1: Add bounded legacy systemd discovery and exact-stop primitives

**Files:**
- Modify: `src/daemon/supervisor.ts`
- Modify: `test/daemon/coverage-400-supervisor.test.ts`
- Modify: `test/daemon/supervisor.test.ts` where public classification invariants live

**Interfaces:**
- Consumes: existing bounded `SupervisorCommandRunner`, operation deadlines, systemd parsing, sleep/poll seams.
- Produces: optional systemd capabilities on `Supervisor`:

```ts
export interface LegacySystemdUnit {
  readonly name: string;
  readonly managerPid: number;
}

export type LegacySystemdDiscovery =
  | { readonly kind: "candidates"; readonly candidates: readonly LegacySystemdUnit[] }
  | { readonly kind: "unavailable"; readonly reason: SupervisorReason };

export interface Supervisor {
  // existing methods remain unchanged
  readonly discoverLegacySystemdUnits?: (
    options?: SupervisorOperationOptions,
  ) => Promise<LegacySystemdDiscovery>;
  readonly stopLegacySystemdUnit?: (
    candidate: LegacySystemdUnit,
    options?: SupervisorOperationOptions,
  ) => Promise<void>;
}
```

- [ ] **Step 1: Add parser/discovery RED tests**

Use the injected command runner to return `systemctl --user list-units` output containing:

```text
lcm-daemon-1234-1720000000000.service loaded active running legacy
lcm-daemon-0123456789abcdef0123.service loaded active running stable
lcm-daemon-1234-not-a-time.service loaded active running malformed
other.service loaded active running unrelated
```

Require only the strict historical grammar `^lcm-daemon-[1-9][0-9]*-[1-9][0-9]*\.service$` to be inspected. Return candidate PID only after bounded exact `systemctl --user show <name>` reports loaded, active/running, and a positive `MainPID`.

Add cases for zero candidates, multiple candidates, duplicate lines, malformed PID, non-running state, not-found races, command timeout, permission failure, nonzero unexpected status, launchd, and operation-deadline exhaustion. Assert raw stdout/stderr is absent from returned structures. Revalidate the strict historical name grammar inside `stopLegacySystemdUnit`; callers cannot smuggle a stable or arbitrary service name through the public candidate type.

- [ ] **Step 2: Run RED**

```bash
npm exec -- vitest run test/daemon/coverage-400-supervisor.test.ts \
  test/daemon/supervisor.test.ts -t "legacy generated systemd"
```

Expected: the Supervisor capabilities do not exist.

- [ ] **Step 3: Implement strict discovery**

For systemd only, run a bounded argv command equivalent to:

```ts
["--user", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"]
```

Filter complete unit-name tokens with the strict historical regex, deduplicate, sort, and inspect each exact name with bounded `show` properties. Stable digest names and malformed names are ignored, not mutated. Transport/permission ambiguity returns `unavailable`; an exact not-found candidate is treated as a discovery race and omitted.

An exact strict unit not positively loaded/active/running with a positive
`MainPID` is a fail-closed `state-conflict`. This includes reloading,
refreshing, activating, deactivating, maintenance, inactive, failed, malformed,
unloaded, and future states. It is neither an authenticated candidate nor safe
absence. Only code-0 `LoadState=not-found` with no PID, or systemd's exact
not-found command result, is omitted as genuine disappearance.

- [ ] **Step 4: Add exact-stop RED tests**

Given `{ name, managerPid }`, require an immediate exact `show` to report the same active PID, then exact `systemctl --user stop <name>`, followed by bounded polling until `LoadState=not-found` (or the existing parser's equivalent exact absence proof) and `MainPID` is zero/missing. A loaded inactive or failed unit is not absence and must refuse. Identity/name change, malformed state, timeout, stop error, or a still-loaded unit must reject. Assert every runner argv uses the exact name and no wildcard/shell.

- [ ] **Step 5: Run exact-stop tests RED**

```bash
npm exec -- vitest run test/daemon/coverage-400-supervisor.test.ts \
  test/daemon/supervisor.test.ts -t "legacy generated systemd"
```

Expected: discovery and exact-stop tests fail because the capabilities do not exist.

- [ ] **Step 6: Implement exact stop and run GREEN**

Reuse existing systemd state parsing, manager deadlines, poll bounds, and interruption behavior. Do not route a metadata-free legacy unit through `stopAndAwaitAbsentInternal`, because that path deliberately requires stable supervisor metadata.

```bash
npm exec -- vitest run test/daemon/coverage-400-supervisor.test.ts \
  test/daemon/supervisor.test.ts
```

Expected: complete supervisor suites pass, including existing foreign stable-unit refusals.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/supervisor.ts test/daemon/coverage-400-supervisor.test.ts \
  test/daemon/supervisor.test.ts
git commit -S --signoff -m "fix(daemon): inspect legacy systemd units safely"
```

### Task 2: Authenticate and migrate one legacy daemon during explicit restart

**Files:**
- Modify: `src/daemon/lifecycle.ts`
- Modify: `test/daemon/coverage-400-lifecycle-restart.test.ts`
- Modify: `test/daemon/coverage-400-lifecycle-managed.test.ts`

**Interfaces:**
- Consumes: Task 1 discovery/stop capabilities and existing `checkDaemonDiagnostics`, process identity, PID-state, listener-ownership, request-deadline, and stable manager-start paths.
- Produces: a private authenticated legacy migration result used only when stable systemd probe returns `absent` during explicit restart.

- [ ] **Step 1: Add complete positive RED regression**

Build a hermetic Linux fixture with:

- owned canonical `daemon.pid` containing PID `4242` and a valid token;
- `/proc/4242/cmdline` for an LCM daemon start and matching expected entrypoint;
- `/proc` socket evidence that PID `4242` owns the configured loopback port;
- public health and token-authenticated health/access reporting PID `4242`, the same owner/storage identity, and an older LCM version;
- stable supervisor probe `absent`;
- exactly one discovery candidate `lcm-daemon-1234-1720000000000.service` with manager PID `4242`;
- successful exact legacy stop/absence in which the legacy daemon removes its own PID file; and
- the normal stable supervisor start plus authenticated replacement health.

Expect `restartDaemon` to report connected/restarted, `stoppedPid: 4242`, and `startMethod: "systemd-user"`. Assert exact operation order: stable probe, legacy discovery, endpoint/diagnostics/process/listener authentication, exact stop, PID death/cleanup, stable start, stable admission. Assert process kill seams are never called.

- [ ] **Step 2: Run RED**

```bash
npm exec -- vitest run test/daemon/coverage-400-lifecycle-restart.test.ts \
  -t "migrates an authenticated legacy generated systemd daemon"
```

Expected: current restart returns `not-running` or `invalid-collision` and never stops/starts the legacy candidate.

- [ ] **Step 3: Add the complete fail-closed matrix before implementation**

Table-drive one mismatch at a time: missing/malformed PID before authentication; symlink/non-regular/no-follow PID and token paths; descriptor replacement between reads; unstable PID values; dead PID; zero/multiple/disappearing candidates; manager PID mismatch; invalid public health; token read/auth failure; authenticated identity mismatch; diagnostics access failure; incompatible/current version; wrong process/entrypoint; wrong/no listener; pre-stop candidate change; stop failure; any PID pathname remaining after stop; PID remaining alive; interruption/deadline exhaustion. Add a successful graceful-stop case where the exact stopped daemon removes its own PID file. Inject regular-file replacement, symlink, and hardlink path insertions immediately after the post-stop descriptor closes at the former cleanup seam. Assert no stop for pre-auth failures, no stable start after stop failure, no pathname unlink for any remaining PID evidence, no kill, and no unrelated cleanup. For initially missing PID evidence, assert strict discovery runs: any candidate refuses without stable start or ensure, while zero candidates preserves normal absent startup.

- [ ] **Step 4: Run the positive and refusal matrix RED**

```bash
npm exec -- vitest run test/daemon/coverage-400-lifecycle-restart.test.ts \
  -t "legacy generated systemd"
```

Expected: the positive migration and new capability-dependent cases fail against current absent-plus-live-PID behavior for the intended reason; preservation controls remain green.

- [ ] **Step 5: Implement a single authenticated migration helper**

Inside managed restart, after the stable probe returns `absent` and before `exactNoLivePidProof`, call a private helper only when:

```ts
managerKind === "systemd-user"
  && supervisor.discoverLegacySystemdUnits !== undefined
  && supervisor.stopLegacySystemdUnit !== undefined
```

The helper must:

1. read the owned PID twice and require one stable live positive PID before authenticating a candidate;
2. if both reads are missing, perform bounded strict discovery before returning not-applicable: zero candidates preserve ordinary absent startup, while any candidate, unavailable discovery, or discovery failure refuses stable start without calling ensure;
3. otherwise discover exactly one candidate and require its manager PID to equal the owned PID;
4. observe valid public health for the configured loopback endpoint;
5. call `checkDaemonDiagnostics` with the owned token and require the same health identity/PID and authenticated access;
6. accept only strict stable `major.minor.patch` versions with the same major/minor as the installed version and a lower patch number; reject current, newer, prerelease, malformed, cross-minor, and cross-major versions;
7. require `processEntrypointMatches`, likely-LCM daemon command, and exact loopback listener ownership for the same PID;
8. rediscover and require the same sole `{ name, managerPid }` immediately before mutation;
9. call exact stop and require the stopped PID no longer live;
10. after exact unit absence and PID death, descriptor-safely re-observe the canonical PID path and continue only when it is absent because the stopped daemon removed it. Any present regular file, replacement, symlink, hardlink, malformed file, or otherwise unsafe evidence is preserved and refuses stable start. Never close an authenticated descriptor and then mutate its pathname; no portable atomic identity-bound unlink primitive exists here;
11. return a typed migration result carrying `stoppedPid` only after PID-file disappearance, then enter the existing stable manager start/admission path so `RestartDaemonResult.stoppedPid` reports the legacy PID even though the stable observation began `absent`; and
12. preserve evidence and return a bounded refusal without mutation on every mismatch.

Do not broaden `staleReason`, stable-unit classification, or detached recovery.

- [ ] **Step 6: Run GREEN and adjacent suites**

```bash
npm exec -- vitest run test/daemon/coverage-400-lifecycle-restart.test.ts \
  test/daemon/coverage-400-lifecycle-managed.test.ts \
  test/daemon/lifecycle.test.ts test/daemon/lifecycle-isolation.test.ts
```

Expected: all selected tests pass with every new branch covered.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/lifecycle.ts \
  test/daemon/coverage-400-lifecycle-restart.test.ts \
  test/daemon/coverage-400-lifecycle-managed.test.ts
git commit -S --signoff -m "fix(daemon): migrate authenticated legacy service"
```

### Task 3: Prove doctor recovery, document the contract, and add release metadata

**Files:**
- Modify: `src/doctor/doctor.ts`
- Modify: `test/doctor/doctor.test.ts`
- Modify: `test/coverage-services-doctor.test.ts`
- Modify: `docs/daemon-restart-recovery.md`
- Modify: `docs/configuration.md`
- Create: `.changeset/safe-legacy-daemon-migration.md`

**Interfaces:**
- Consumes: explicit restart migration from Task 2.
- Produces: doctor remediation evidence and user-facing upgrade contract.

- [ ] **Step 1: Add doctor-level RED tests and mocks**

Extend lifecycle mocks in both doctor test files to expose `restartDaemon`. Add tests asserting version-mismatch health must call `restartDaemon` with the bounded lifecycle options and must not call `ensureDaemon`; matching-version health continues to call `ensureDaemon` and not `restartDaemon`. The mismatch fixture represents an authenticated old daemon and reports recovery only after replacement health matches the installed version. Ambiguous legacy evidence remains a failure with actionable restart/inspection guidance.

- [ ] **Step 2: Run doctor routing RED**

```bash
npm exec -- vitest run test/doctor/doctor.test.ts test/coverage-services-doctor.test.ts \
  -t "version mismatch|legacy"
```

Expected: mismatch-routing assertions fail because doctor currently imports and calls only `ensureDaemon`; matching-version preservation controls pass.

- [ ] **Step 3: Implement mismatch routing**

In `src/doctor/doctor.ts`, import both lifecycle operations in the healthy-daemon path and select exactly once:

```ts
const lifecycleResult = versionMismatch
  ? await restartDaemon(lifecycleOptions)
  : await ensureDaemon(lifecycleOptions);
```

Use the existing bounded options object unchanged and preserve all post-operation authenticated-health checks, result messages, remediation markers, publication gates, and matching-version behavior.

- [ ] **Step 4: Run doctor routing GREEN**

Run the Step 2 command unchanged.

Expected: mismatch and matching-version cases pass with mutually exclusive lifecycle calls.

- [ ] **Step 5: Update user documentation**

Document that Linux upgrades from v1.4.1 may require a one-time authenticated migration; enumerate the independent checks at a user-comprehensible level; state that only daemon-owned PID-file disappearance permits stable replacement and every remaining path is preserved; state that a missing PID with any discovered legacy candidate refuses; recommend `lcm doctor` or `lcm daemon restart`; prohibit manual wildcard service stops and competing daemon starts.

- [ ] **Step 6: Add patch Changeset**

```md
---
"@donadiosolutions/lcm": patch
---

Recover authenticated legacy Linux daemon services safely after upgrading.
```

- [ ] **Step 7: Commit**

```bash
git add src/doctor/doctor.ts test/doctor/doctor.test.ts \
  test/coverage-services-doctor.test.ts docs/daemon-restart-recovery.md \
  docs/configuration.md .changeset/safe-legacy-daemon-migration.md
git commit -S --signoff -m "fix(doctor): restart mismatched legacy daemon"
```

### Task 4: Verify the complete branch

- [ ] **Step 1: Run complete daemon/service-manager suites**

```bash
npm exec -- vitest run test/daemon test/doctor/doctor.test.ts \
  test/coverage-services-doctor.test.ts test/codecov-config.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run static and canonical coverage gates**

```bash
npm run build
npm run typecheck
npm run lint
npm run test:ci
```

Expected: all commands exit zero and complete/per-file coverage is exactly 100% lines, branches, functions, and statements.

- [ ] **Step 3: Audit security scope and signatures**

```bash
IMPLEMENTATION_BASE=$(
  git rev-parse --verify 'refs/lcm/implementation-bases/issue-600-legacy-daemon^{commit}'
)
git diff --check "$IMPLEMENTATION_BASE"...HEAD
git status --short
git log --show-signature --format=fuller "$IMPLEMENTATION_BASE"..HEAD
rg -n "pkill|killall|systemctl.*\*|v8 ignore|coverage.*ignore" \
  src/daemon test/daemon docs .changeset
```

Expected: clean worktree, valid GPG/DCO, no broad mutation, no exclusion, no dependency change, and foreign stable-unit tests remain fail-closed.

### Task 5: Address post-implementation security review findings

**Files:**
- Modify: `src/daemon/lifecycle.ts`
- Modify: `test/daemon/coverage-400-lifecycle-restart.test.ts`
- Modify: `docs/daemon-restart-recovery.md`
- Modify: `docs/configuration.md`
- Modify: `.changeset/safe-legacy-daemon-migration.md`
- Modify: `.github/copilot-instructions.md`

**Interfaces:**
- Consumes: Task 1 strict bounded discovery and Task 2 authenticated exact-stop migration.
- Produces: disappearance-only post-stop admission and missing-PID candidate refusal without pathname mutation.

- [ ] **Step 1: Add post-stop pathname RED regressions**

Change the unchanged-present case to require `restarted: false`, `refusalReason: "ambiguous"`, preserved PID evidence, no unlink, no stable supervisor start, and no ensure. Add deterministic replacement, symlink, and hardlink insertion immediately after the post-stop descriptor closes; require the same refusal and preservation properties.

- [ ] **Step 2: Run post-stop RED**

```bash
npm exec -- vitest run test/daemon/coverage-400-lifecycle-restart.test.ts \
  -t "remaining PID|former cleanup seam"
```

Expected: the unchanged path is unlinked and starts the stable unit; race insertions expose pathname cleanup behavior.

- [ ] **Step 3: Remove post-stop pathname cleanup and run GREEN**

Accept only `afterStopPid.kind === "missing"`. Return a bounded ambiguous refusal for every present or unsafe result without calling `unlinkSync`, stable supervisor start, or ensure. Run the Step 2 command unchanged and require all cases to pass.

- [ ] **Step 4: Add missing-PID discovery RED regressions**

For two missing PID reads with one strict legacy candidate, require explicit ambiguous refusal and assert discovery runs while stop, stable start, and ensure do not. Add the zero-candidate control requiring normal absent startup through ensure.

- [ ] **Step 5: Run missing-PID RED**

```bash
npm exec -- vitest run test/daemon/coverage-400-lifecycle-restart.test.ts \
  -t "missing PID evidence"
```

Expected: candidate-present incorrectly reaches normal absent startup and zero-candidate discovery is not called.

- [ ] **Step 6: Implement bounded missing-PID discovery and run GREEN**

Move the bounded discovery helper before the missing-PID branch. On two missing reads, return not-applicable only for a successful zero-candidate discovery; return the existing sanitized manager refusal for unavailable/error results and an explicit ambiguous refusal for one or more candidates. Run the Step 5 command unchanged.

- [ ] **Step 7: Align docs and reusable review guidance**

Remove every promise that LCM cleans an unchanged post-stop PID file. State that only daemon-owned disappearance succeeds and any remaining pathname is preserved. Add a Copilot instruction that descriptor/path identity validation followed by pathname mutation is racy unless an atomic identity-bound primitive exists; prefer fail-closed no mutation.

- [ ] **Step 8: Verify and commit without rewriting history**

Run the complete Task 4 verification, require 100% coverage in all dimensions, then create a new GPG-signed DCO commit with `git commit -S --signoff`. Do not amend, rebase, force-push, push, or open a PR.

### Task 6: Address transitional discovery and descriptor-close review findings

**Files:**
- Modify: `src/daemon/supervisor.ts`
- Modify: `src/daemon/lifecycle.ts`
- Modify: `src/doctor/doctor.ts`
- Modify: focused supervisor/lifecycle and Codecov contract tests
- Modify: Codecov metadata, user docs, Changeset, and Copilot instructions

- [ ] **Step 1: Add #613 RED regressions**

Require `--all` enumeration before strict historical-name filtering. Cover
realistic `running`, `start`, `start-post`, `reload`, `stop`, `stop-sigterm`,
`failed`, and `dead` substates across active, reloading, refreshing, activating,
deactivating, maintenance, inactive, and failed states. Every discoverable
strict unit without exact running authentication returns fail-closed
`state-conflict`; missing PID evidence then reaches no exact stop, stable start,
or ensure call. Near-miss names remain excluded.

- [ ] **Step 2: Implement #613 and run focused GREEN**

Enumerate all service units with `--all --no-pager`, retain the exact strict-name
filter, and treat exact listed non-running state as conflict. Only
loaded/active/running state with a positive `MainPID` becomes a candidate; only
exact not-found evidence becomes disappearance. Add direct exact-stop tests
proving every untrusted state refuses after `show` and before `stop`.

- [ ] **Step 3: Add #612 RED regression**

Inject a `closeSync` failure after otherwise valid PID evidence and prove the
close is attempted while migration currently proceeds incorrectly. Require no
discovery, stop, unlink, stable start, or ensure in the corrected behavior.

- [ ] **Step 4: Implement #612 and run focused GREEN**

Stage the evidence result until descriptor cleanup completes. Any close failure
overrides present evidence to `unsafe` before migration can authenticate or
mutate state.

- [ ] **Step 5: Complete review maintenance and verify**

Rename doctor's selected-operation result to `lifecycleResult`; update the
existing Codecov service-manager component description atomically without
changing its already-complete ownership; align docs, Changeset, and reusable
review policy; run focused suites, build, typecheck, lint, and fresh `test:ci`.

#### Reconstructed RED evidence against clean `cb76e425`

The draft production patch already existed when the complete-state addendum
arrived, so the test-first proof was reconstructed objectively without rewriting
history: the full working patch was stashed, only the two updated regression
test files were restored over clean `cb76e425`, the command below was run, the
test-only changes were discarded, and the full patch was restored.

```bash
npm exec -- vitest run test/daemon/coverage-400-supervisor.test.ts \
  test/daemon/coverage-400-lifecycle-restart.test.ts \
  -t "complete state policy|untrusted|malformed exact state|descriptor close failure|strict legacy unit is|discovers only strict legacy names|explicit (not-found|unloaded) state"
```

Result: 2 test files failed; 13 tests failed, 22 passed, and 239 were skipped.
Twelve discovery assertions showed the clean baseline still invoked
`--state=active` or returned false-zero candidates for strict non-running
states. The close-failure regression showed the descriptor close was attempted
but migration returned `restarted: true` instead of refusing. The direct-stop
untrusted-state cases passed on the baseline, accurately proving its immediate
exact-`show` revalidation already prevented stop; #613 was the earlier discovery
omission/classification seam, not an exact-stop authorization bypass.
