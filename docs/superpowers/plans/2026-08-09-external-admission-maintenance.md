# External Admission Maintenance-Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #562 and #567 by making every authenticated admission event reconcile the latest exact-head snapshot and by admitting only protected `main` or protected `maintenance/X.Y.x` bases.

**Architecture:** Keep the workflow as a trusted default-branch reducer. Every accepted DCO/CI/dispatch event checks out the pinned evaluator and evaluates current GitHub state, so a stale event can never leave an orphaned pending status. Move base eligibility into a pure policy function backed by live branch-protection metadata; code admits the maintenance namespace only after the repository ruleset actually protects it.

**Tech Stack:** GitHub Actions YAML, Bash, Node.js ESM, jq, GitHub CLI/API, Node test runner, Vitest workflow tests.

## Global Constraints

- Start `fix/external-admission-maintenance` from current `origin/main` after prerequisite PRs merge.
- Add no dependency. Preserve action pins `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` and `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020`.
- Preserve explicit permissions: `actions/checks/contents/pull-requests: read`, `statuses: write`, and no broader permission.
- Never execute or check out PR-controlled content; evaluator code comes from `github.workflow_sha` with persisted credentials disabled.
- Reject wrong repository, wrong workflow path/name/event, invalid SHA, queue refs, drafts, closed PRs, unsupported/unprotected bases, non-unique associations, and changed evidence.
- Maintenance eligibility is exactly `maintenance/[0-9]+\.[0-9]+\.x` plus live `protected=true` on the base repository.
- Use DCO `--signoff`; merge commits only; no Changeset because this is repository governance, not npm runtime behavior.
- Update workflow docs and Copilot instructions atomically with code.

---

### Task 1: Define the pure protected-base contract

**Files:**
- Modify: `.github/scripts/external-admission-policy.mjs`
- Modify: `.github/scripts/external-admission-policy.test.mjs`

**Interfaces:**
- Consumes: a GitHub PR object, exact event head SHA, repository full name, and live base-branch `protected` boolean.
- Produces: `evaluatePullRequestEligibility({ pullRequest, headSha, repository, baseProtected }) -> { eligible, reason }`.

- [ ] **Step 1: Add failing table tests**

Add fixtures for:

```js
const eligibleMain = {
  state: "open",
  draft: false,
  head: { sha: HEAD_SHA },
  base: { ref: "main", repo: { full_name: REPOSITORY } },
};
const eligibleMaintenance = {
  ...eligibleMain,
  base: { ref: "maintenance/1.4.x", repo: { full_name: REPOSITORY } },
};
```

Assert:

```js
assert.deepEqual(evaluatePullRequestEligibility({
  pullRequest: eligibleMain,
  headSha: HEAD_SHA,
  repository: REPOSITORY,
  baseProtected: true,
}), { eligible: true });

assert.deepEqual(evaluatePullRequestEligibility({
  pullRequest: eligibleMaintenance,
  headSha: HEAD_SHA,
  repository: REPOSITORY,
  baseProtected: true,
}), { eligible: true });
```

Table-driven rejected cases must include `maintenance/1.x`, `maintenance/1.4`, `maintenance/security`, `release/1.4.x`, an unprotected maintenance branch, wrong base repository, wrong head SHA, draft, closed, and malformed input. Each rejection asserts a stable bounded `reason` such as `unsupported-base`, `unprotected-base`, `repository-mismatch`, or `ineligible-pr`.

- [ ] **Step 2: Verify RED**

```bash
node --test .github/scripts/external-admission-policy.test.mjs
```

Expected: import/export failure because `evaluatePullRequestEligibility` does not exist.

- [ ] **Step 3: Implement the minimal pure function**

```js
const MAINTENANCE_BASE = /^maintenance\/[0-9]+\.[0-9]+\.x$/u;

export function evaluatePullRequestEligibility({
  pullRequest,
  headSha,
  repository,
  baseProtected,
}) {
  requireNonEmptyString(headSha, "head SHA");
  requireNonEmptyString(repository, "repository");
  if (pullRequest === null || typeof pullRequest !== "object" || Array.isArray(pullRequest)) {
    return { eligible: false, reason: "ineligible-pr" };
  }
  if (pullRequest.state !== "open" || pullRequest.draft !== false || pullRequest.head?.sha !== headSha) {
    return { eligible: false, reason: "ineligible-pr" };
  }
  if (pullRequest.base?.repo?.full_name !== repository) {
    return { eligible: false, reason: "repository-mismatch" };
  }
  const baseRef = pullRequest.base?.ref;
  if (baseRef !== "main" && !(typeof baseRef === "string" && MAINTENANCE_BASE.test(baseRef))) {
    return { eligible: false, reason: "unsupported-base" };
  }
  if (baseProtected !== true) return { eligible: false, reason: "unprotected-base" };
  return { eligible: true };
}
```

Add a `runPolicyCommand` branch named `evaluate-pr` that accepts `headSha`, `repository`, and `baseProtected` (`"true"`/`"false"`) and reads the PR JSON from stdin.

- [ ] **Step 4: Verify GREEN and commit**

```bash
node --test .github/scripts/external-admission-policy.test.mjs
git add .github/scripts/external-admission-policy.mjs .github/scripts/external-admission-policy.test.mjs
git commit --signoff -m "test(admission): define protected base policy"
```

### Task 2: Make every accepted event run the same reducer (#562)

**Files:**
- Modify: `.github/workflows/external-admission.yml:112`
- Modify: `test/external-admission-workflow.test.ts`

**Interfaces:**
- Consumes: job-level authenticated-event predicate and normalized `EVENT_HEAD_SHA`.
- Produces: checkout, Node setup, and evaluator execution for every event that enters the write-capable job.

- [ ] **Step 1: Add failing workflow assertions**

Replace assertions that expect checkout/setup/evaluation to be gated by `github.event.action == 'completed'`. Require the three steps to have no step-level `if`, while retaining the job-level identity predicate and the unconditional pre-checkout revocation.

Add source-fixture tests for `workflow_run` `requested`, `in_progress`, and `completed`, DCO `created`, `rerequested`, and `completed`, and valid repository dispatch. Every accepted fixture must reach the evaluator. Wrong CI path/repository/event and queue-ref DCO remain job-skipped and must never write a status.

- [ ] **Step 2: Verify RED**

```bash
npm exec -- vitest run test/external-admission-workflow.test.ts
```

Expected: new assertions fail because the three reducer steps still carry the completed-action condition.

- [ ] **Step 3: Remove only the three step-level completed-action predicates**

Delete `if:` from:

- `Check out trusted admission evaluator`
- `Set up Node.js`
- `Evaluate external admission snapshot`

Keep their action pins, checkout ref, sparse paths, credentials setting, and job-level `if` unchanged.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm exec -- vitest run test/external-admission-workflow.test.ts
git add .github/workflows/external-admission.yml test/external-admission-workflow.test.ts
git commit --signoff -m "fix(admission): reconcile every trusted event"
```

### Task 3: Reconcile current state and protected bases in the shell evaluator

**Files:**
- Modify: `.github/scripts/external-admission.sh`
- Modify: `test/external-admission-workflow.test.ts`
- Verify: `.github/scripts/external-admission-policy.mjs`

**Interfaces:**
- Consumes: associated PR pages, exact PR JSON, live base-branch metadata, latest authenticated CI/DCO checks, canonical CI run metadata.
- Produces: exactly one terminal/current status for the exact head: pending for genuinely incomplete latest evidence, failure for invalid/ineligible evidence, success for stable exact-head evidence.

- [ ] **Step 1: Add failing shell-harness cases**

Extend the existing fake-`gh` harness with these scenarios:

1. A stale completed `workflow_run` ID while the latest exact-head CI check points to a newer successful run: expect final `success`, not orphaned `pending`.
2. A non-completed trusted event with latest exact-head CI/DCO success: expect final `success`.
3. No unique eligible PR after revocation: expect terminal `failure`.
4. Protected `main`: eligible.
5. Protected `maintenance/1.4.x`: eligible.
6. Unprotected `maintenance/1.4.x`: terminal `failure`.
7. Unsupported base, wrong base repository, or changed protection/eligibility between initial and final checks: terminal `failure` or bounded current `pending` according to whether evidence is invalid or merely transient.

The fake API must serve `repos/$REPOSITORY/branches/<url-encoded-ref>` with `{ "protected": true|false }` and record all status writes.

- [ ] **Step 2: Verify RED**

```bash
npm exec -- vitest run test/external-admission-workflow.test.ts
```

Expected: current hard-coded `main` logic rejects maintenance; stale run mismatch exits pending; non-unique PR exits without terminal failure.

- [ ] **Step 3: Replace jq-only eligibility with policy-backed evaluation**

Add:

```bash
fetch_base_branch() {
  local base_ref="$1"
  local encoded_ref
  encoded_ref="$(jq -rn --arg value "$base_ref" '$value|@uri')"
  gh api -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPOSITORY/branches/$encoded_ref"
}

evaluate_pull_request() {
  local pull_request="$1"
  local base_ref branch protected
  base_ref="$(jq -r '.base.ref // empty' <<<"$pull_request")"
  branch="$(fetch_base_branch "$base_ref")"
  protected="$(jq -r '.protected == true' <<<"$branch")"
  node .github/scripts/external-admission-policy.mjs evaluate-pr \
    "$HEAD_SHA" "$REPOSITORY" "$protected" <<<"$pull_request"
}
```

Use the policy result both when selecting the unique associated PR and on every initial/current/final PR revalidation. Re-fetch live branch metadata each time; protection changes invalidate admission.

- [ ] **Step 4: Remove stale event-ID authority**

Delete the branch in `validate_required_snapshot` that exits pending when `EVENT_WORKFLOW_RUN_ID` differs from the latest authenticated CI `ciRunId`. Log the stale ID for diagnostics, but always fetch and evaluate the latest canonical CI run selected by the latest authenticated aggregate check. The event wakes the reducer; current exact-head state decides the result.

- [ ] **Step 5: Make ineligible/ambiguous evidence terminal**

After revocation, if there is not exactly one eligible associated PR, write `failure` with a bounded description such as `Pull request is not uniquely eligible for admission`, clear traps, and exit zero. Use the same terminal failure for unsupported/unprotected base and repository mismatch. Reserve `pending` for current trusted check/run states that are genuinely waiting.

- [ ] **Step 6: Verify syntax and focused behavior**

```bash
bash -n .github/scripts/external-admission.sh
node --test .github/scripts/external-admission-policy.test.mjs
npm exec -- vitest run test/external-admission-workflow.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add .github/scripts/external-admission.sh \
  .github/scripts/external-admission-policy.mjs \
  .github/scripts/external-admission-policy.test.mjs \
  test/external-admission-workflow.test.ts
git commit --signoff -m "fix(admission): protect exact-head reconciliation"
```

### Task 4: Align governance documentation

**Files:**
- Modify: `WORKFLOW.md`
- Modify: `docs/external-admission.md`
- Modify: `.github/copilot-instructions.md`

**Interfaces:**
- Consumes: Final reducer and protected-base contract.
- Produces: One consistent maintainer/operator description.

- [ ] **Step 1: Update all three documents**

State explicitly:

- every accepted trusted event evaluates the latest exact-head snapshot;
- stale event IDs are wake-ups, not state authority;
- only protected `main` or protected `maintenance/X.Y.x` bases are eligible;
- live base protection and PR eligibility are revalidated before success;
- invalid/ineligible evidence becomes terminal failure, while incomplete current checks remain pending;
- the evaluator never executes PR content.

- [ ] **Step 2: Run documentation/workflow regressions and commit**

```bash
npm exec -- vitest run test/external-admission-workflow.test.ts \
  test/daemon/remediation-string-regression.test.ts
git diff --check
git add WORKFLOW.md docs/external-admission.md .github/copilot-instructions.md
git commit --signoff -m "docs(admission): describe protected maintenance flow"
```

### Task 5: Verify, review, and merge the code PR

**Files:**
- Review all files from Tasks 1-4.

**Interfaces:**
- Consumes: Complete external-admission branch.
- Produces: A merged mainline reducer fix for #562 and the code half of #567.

- [ ] **Step 1: Run all gates fresh**

```bash
node --test .github/scripts/*.test.mjs
bash -n .github/scripts/external-admission.sh
npm run test:ci
npm run lint
npm run typecheck
npm run build
git diff --check
```

If repository-provided ShellCheck or actionlint commands exist, run those exact pinned/provided commands; do not download an unpinned binary.

- [ ] **Step 2: Run MoM review**

Dispatch max-effort GLM and Kimi adversarial reviews, then medium-effort Opus with both reports. Return findings to max-effort Luna workers and rerun Step 1 after every fix round.

- [ ] **Step 3: Open and merge the PR**

Use title `Reconcile external admission for protected maintenance branches`. Explain both issue root causes, truth table, trust boundary, unchanged action pins/permissions, docs, no Changeset, and include `Closes #562`. Reference #567 without auto-closing it because live ruleset protection is still required.

Complete all exact-head checks and Copilot threads, then merge with:

```bash
gh pr merge "$PR_NUMBER" --repo donadiosolutions/lcm --merge --delete-branch
```

### Task 6: Protect the maintenance namespace and close #567

**Files:**
- Temporary outside repository: ruleset JSON snapshots under `$(mktemp -d)`
- External state: GitHub repository ruleset `15870347` or its current successor discovered by name/target.

**Interfaces:**
- Consumes: The merged mainline reducer and the current active main protection ruleset.
- Produces: The same required protection rules on `refs/heads/maintenance/*`, making live branch metadata `protected=true`.

- [ ] **Step 1: Re-read the live ruleset and branch state**

```bash
RULESET_ID=15870347
gh api "repos/donadiosolutions/lcm/rulesets/$RULESET_ID"
gh api repos/donadiosolutions/lcm/branches/maintenance%2F1.4.x --jq '{name,protected}'
```

If the ruleset ID changed, locate the one with target `branch`, enforcement `active`, and condition including `~DEFAULT_BRANCH`. Do not assume stale rule content.

- [ ] **Step 2: Build a preservation-safe update payload**

```bash
tmp=$(mktemp -d)
gh api "repos/donadiosolutions/lcm/rulesets/$RULESET_ID" >"$tmp/current.json"
jq '
  {
    name,
    target,
    enforcement,
    bypass_actors,
    conditions,
    rules
  }
  | .conditions.ref_name.include = (
      (.conditions.ref_name.include + ["refs/heads/maintenance/*"]) | unique
    )
' "$tmp/current.json" >"$tmp/update.json"
```

Review the complete current and proposed payloads. The only semantic difference must be the added maintenance include; required checks, bypass actors, enforcement, exclusions, and every rule remain byte-equivalent after normalized JSON comparison.

- [ ] **Step 3: Apply and verify the ruleset update**

```bash
gh api --method PUT \
  "repos/donadiosolutions/lcm/rulesets/$RULESET_ID" \
  --input "$tmp/update.json"
gh api repos/donadiosolutions/lcm/branches/maintenance%2F1.4.x \
  --jq '{name,protected}'
```

Expected: `protected` is `true`. Do not use administrator bypass to merge or weaken any rule.

- [ ] **Step 4: Reconcile and close #567**

Post evidence to #567 naming the merged reducer PR/commit, the active ruleset, the protected maintenance branch response, focused tests, and full coverage result. Close as completed only after all evidence is current.
