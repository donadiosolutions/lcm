# Legacy Daemon Upgrade Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #600 by safely migrating one authenticated v1.4.1 generated Linux systemd unit to the stable managed unit used by v1.4.2.

**Architecture:** Keep stable-unit collision classification fail-closed. Add bounded systemd-only discovery and exact-stop capabilities to the supervisor, then let explicit restart authenticate a single legacy candidate through manager PID, owned state, process command/entrypoint, loopback listener, token-authenticated health/access, and an immediate pre-stop re-probe before starting the normal stable unit.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node.js 25.9.0, Linux `/proc`, systemd user manager, HTTP health/authentication, Git.

## Global Constraints

- In a fresh isolated worker workspace, resolve `REVIEWED_PLANNING_HEAD=$(git rev-parse --verify 'refs/lcm/planning/open-bugs-2026-08-11^{commit}')`, require `test "$(git rev-parse HEAD)" = "$REVIEWED_PLANNING_HEAD"`, persist it with `git update-ref refs/lcm/implementation-bases/legacy-daemon-upgrade-migration "$REVIEWED_PLANNING_HEAD"`, and create branch `fix/legacy-daemon-upgrade-migration` from that exact SHA; never use a `codex/` prefix.
- Do not use, clean, stage, or modify the coordinator worktree or pre-existing files outside this branch.
- The compatibility path is Linux/systemd-only and may mutate state only during explicit restart/doctor repair.
- Historical name matching is discovery input, never ownership proof.
- Require exactly one candidate and agreement across every identity signal before mutation.
- Stop one exact unit name through argv-based `systemctl --user`; never use shell expansion, wildcard stop, `kill`, `pkill`, or broad cleanup.
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
["--user", "list-units", "--type=service", "--state=active", "--no-legend", "--plain"]
```

Filter complete unit-name tokens with the strict historical regex, deduplicate, sort, and inspect each exact name with bounded `show` properties. Stable digest names and malformed names are ignored, not mutated. Transport/permission ambiguity returns `unavailable`; an exact not-found candidate is treated as a discovery race and omitted.

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
- successful exact legacy stop/absence; and
- the normal stable supervisor start plus authenticated replacement health.

Expect `restartDaemon` to report connected/restarted, `stoppedPid: 4242`, and `startMethod: "systemd-user"`. Assert exact operation order: stable probe, legacy discovery, endpoint/diagnostics/process/listener authentication, exact stop, PID death/cleanup, stable start, stable admission. Assert process kill seams are never called.

- [ ] **Step 2: Run RED**

```bash
npm exec -- vitest run test/daemon/coverage-400-lifecycle-restart.test.ts \
  -t "migrates an authenticated legacy generated systemd daemon"
```

Expected: current restart returns `not-running` or `invalid-collision` and never stops/starts the legacy candidate.

- [ ] **Step 3: Add the complete fail-closed matrix before implementation**

Table-drive one mismatch at a time: missing/malformed PID before authentication; symlink/non-regular/no-follow PID and token paths; descriptor replacement between reads; unstable PID values; dead PID; zero/multiple/disappearing candidates; manager PID mismatch; invalid public health; token read/auth failure; authenticated identity mismatch; diagnostics access failure; incompatible/current version; wrong process/entrypoint; wrong/no listener; pre-stop candidate change; stop failure; changed PID file after stop; PID remaining alive; interruption/deadline exhaustion. Add a successful graceful-stop case where the exact stopped daemon removes its own PID file. Assert no stop for pre-auth failures, no stable start after stop failure, no unlink when a replacement PID path appears, no kill, and no unrelated cleanup.

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

1. read the owned PID twice and require one stable live positive PID;
2. discover exactly one candidate and require its manager PID to equal the owned PID;
3. observe valid public health for the configured loopback endpoint;
4. call `checkDaemonDiagnostics` with the owned token and require the same health identity/PID and authenticated access;
5. accept only strict stable `major.minor.patch` versions with the same major/minor as the installed version and a lower patch number; reject current, newer, prerelease, malformed, cross-minor, and cross-major versions;
6. require `processEntrypointMatches`, likely-LCM daemon command, and exact loopback listener ownership for the same PID;
7. rediscover and require the same sole `{ name, managerPid }` immediately before mutation;
8. call exact stop and require the stopped PID no longer live;
9. after exact unit absence and PID death, descriptor-safely re-observe the canonical PID path: accept an absent path because the stopped daemon may remove its own PID file; accept a present path for cleanup only when it is the unchanged regular-file identity and still contains the stopped PID; preserve and refuse stable start for a different PID, replaced descriptor identity, symlink, malformed file, or any other unsafe state;
10. return a typed migration result carrying `stoppedPid`, clean only the unchanged owned PID evidence, and enter the existing stable manager start/admission path so `RestartDaemonResult.stoppedPid` reports the legacy PID even though the stable observation began `absent`; and
11. preserve evidence and return a bounded refusal without mutation on every mismatch.

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

Document that Linux upgrades from v1.4.1 may require a one-time authenticated migration; enumerate the independent checks at a user-comprehensible level; state that ambiguous candidates are untouched; recommend `lcm doctor` or `lcm daemon restart`; prohibit manual wildcard service stops and competing daemon starts.

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
  git rev-parse --verify 'refs/lcm/implementation-bases/legacy-daemon-upgrade-migration^{commit}'
)
git diff --check "$IMPLEMENTATION_BASE"...HEAD
git status --short
git log --show-signature --format=fuller "$IMPLEMENTATION_BASE"..HEAD
rg -n "pkill|killall|systemctl.*\*|v8 ignore|coverage.*ignore" \
  src/daemon test/daemon docs .changeset
```

Expected: clean worktree, valid GPG/DCO, no broad mutation, no exclusion, no dependency change, and foreign stable-unit tests remain fail-closed.
