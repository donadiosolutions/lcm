# Triage and remediate security alerts

Use the repository skill to work through existing Dependabot malware and
vulnerability alerts, GitHub Code Scanning alerts, GitHub Secret Scanning alerts,
and Codex Security cloud findings:

```text
Use $triage-security-issues to triage and remediate all current security alerts.
```

The [skill entrypoint](../.agents/skills/triage-security-issues/SKILL.md) is repository
tooling, not a new `lcm` command. It uses the checkout's GitHub repository by default.
Reading or editing the skill does not start a campaign.

## Inputs and access

Optional invocation instructions:

```text
Use $triage-security-issues with REPOSITORY=owner/repository,
CODEX_CSV=/private/path/findings.csv, and OWNER_MODEL=gpt-6-astra.
```

`REPOSITORY` must match the checkout used for assessment. `CODEX_CSV` supplies an
existing cloud findings export; quoted commas and multiline descriptions are
supported through standard CSV parsing. The coordinator verifies repository and
finding identities, retains each finding URL, and records the export as a dated
snapshot. An export alone cannot establish current cloud status or full coverage.
If live access is unavailable, explicitly choose a snapshot-only scope to proceed
with that limitation. No severity or assignee filter silently narrows the campaign.

GitHub access requires an already authenticated `gh` for the target host. If it is
not authenticated, the agent asks you to run `gh auth login --hostname <host>` and
waits before continuing. There is no GitHub browser login or alternate credential
lookup. All three GitHub alert sources use that authentication; source-specific
read/write permissions are still required. Disabled sources are reported separately
from permission failures and empty results.

For Codex Security, the agent first checks for an authenticated interface that
actually controls the cloud findings inbox. Local Codex Security scan tools are
not assumed to control cloud findings. Otherwise, it invokes the available
Playwright/browser skill to filter the cloud findings page to your repository and
export its complete CSV.

If Codex requires login, you log in directly in a headed browser after the agent
explains campaign-scoped reuse. The campaign permits at most one headed Codex login,
including resumes. Protected browser state is reused headlessly for subsequent
exports and alert updates. It stays outside Git checkouts with owner-only access;
workers receive sanitized findings, not cookies or credentials. If access expires
after that login, the agent reports the blocker instead of repeatedly prompting.
Authentication artifacts are removed when the campaign completes or is abandoned.

## Triage before fixes

The coordinator freezes a complete inventory, assesses every finding, and groups
findings sharing a root cause or closely adjacent causes with one coherent fix.
Each group has one remediation owner; every original alert retains its own
acceptance criteria and source state. Similar titles or nearby paths alone do not
establish a shared cause.

Established false positives, stale findings, and inapplicable claims can be
dismissed during triage with evidence and source readback. Failed setup, inconclusive
reproduction, a missing file, or absence from the latest scan is insufficient.
Uncertain findings stay open. Implementation starts only after the complete triage
and grouping barrier.

The skill **invokes existing skills instead of copying their instructions or
scripts**. It delegates static assessment to `codex-security:triage-finding`, bounded
validation to `codex-security:validation`, and the remediation lifecycle to
[procedural-development](procedural-development.md). Assigned implementers invoke
`codex-security:fix-finding`; explicit security-fix verification requests can invoke
`codex-security:verify-fix`. It also invokes `lcm-memory`, the available browser
skill, and `flock` when their capabilities are needed. Required skills must be
available in the executing agent's catalog; a missing capability is reported rather
than replaced with a duplicated workflow. The entrypoint specifies inputs and
required evidence at each delegation boundary.

## Models and private tracking

The default roster is Alpha with Daybreak Blue required for all triage,
cross-source adjudication, implementation and escalated implementation:

| Role | Default |
| --- | --- |
| Triage, validation and implementation | Daybreak Blue, high reasoning |
| Owner | Sol 5.6, medium reasoning |
| Reviewer A | GLM 5.3, maximum supported reasoning |
| Reviewer B | Grok 4.6, medium reasoning |
| Synthesis reviewer | Opus 5, medium reasoning |

Owner and reviewer slots accept the shared `<ROLE>_MODEL`, `<ROLE>_REASONING` and
`<ROLE>_TIER` invocation instructions. The security model bindings remain Daybreak
Blue in nested calls and escalation. Exact slugs are in the entrypoint; unavailable
routes are reported without silent substitution. Shared owner limits, review
requirements and candidate budgets remain authoritative.

Campaign tracking, assessment evidence and deferred findings stay in private
records instead of automatically creating public Bug/Epic trackers. The shared
delivery workflow receives `FOLLOWUP_CHANNEL=private-record`; follow-ups still
need an owner, acceptance criteria, evidence, and source/candidate/PR links. Public
PR text must not contain credentials or private campaign evidence. Any applicable
repository requirement for an issue uses only a sanitized minimum.

Resume with the same campaign record:

```text
Use $triage-security-issues with RESUME_RUN=<existing-run-id>.
```

Resume preserves the inventory, resolved roles, owner assignments, spent budgets,
login allowance, and source-update evidence. It does not start a fresh campaign.

## Completion

Default execution continues through fixes, required reviews/checks, merge, and
verified source resolution. Narrower requests such as triage-only or draft-only
are honored. A merged PR is not enough: independently confirm closure in every
applicable source, including Dependabot, Code Scanning, Secret Scanning and Codex
Security. Dependabot and Code Scanning must report the fix, and every grouped alert
must meet its own acceptance criteria and have its source state read back.

Secret removal from code does not prove credential revocation. The agent does not
replay discovered credentials or rotate/revoke external credentials without the
necessary authorization. Codex status changes must be confirmed in the cloud inbox.

The final report separates verified dismissals, already-resolved findings, merged
fixes with confirmed closure, pending scanner verification, and external blockers.
It also reports source coverage, group counts and private follow-ups. Pending or
blocked findings are never counted as fixed. Existing repository delivery, coverage,
documentation, release-note and LCM environment requirements continue to apply.
