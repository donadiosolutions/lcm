---
name: triage-security-issues
description: Use when asked to coordinate triage and remediation of a repository's Dependabot malware/vulnerability, GitHub Code Scanning, GitHub Secret Scanning, and Codex Security cloud alerts. Not for starting a new scan or merely authoring or reviewing skills.
---

# Triage security issues

## Contract and mandatory reuse

Execution covers inventory, complete triage/grouping, then remediation through
verified source resolution, subject to narrower user limits. Authoring, reviewing,
or testing this skill never starts a campaign or authorizes live alert mutations.

**Invoke existing skills that implement the needed capability. Do not duplicate
their natural-language procedures or copy their scripts.** This rule applies to
authors and executing agents. This wrapper owns only security-source acquisition,
identity, private accounting, cross-source grouping and source-resolution policy.
Inspect available skills/helpers before adding code for a demonstrated gap; do not
build another GitHub client, browser-session manager, campaign engine or delivery
script. Do not invoke `triage-fix-all-bugs`: its native Bug input contract differs.

Read repository/local instructions and [LCM integration](../shared/lcm-development.md).
Invoke `lcm-memory` for required project context without storing raw findings or
credentials. Read [procedural-development](../procedural-development/SKILL.md) and
its coordination/delivery references. Apply its
[root lifecycle admission](../procedural-development/references/root-lifecycle.md)
before triage dispatch or unattended waiting. Every worker receives the
[worker execution brief](../procedural-development/references/worker-execution.md)
and must supply its command completion/cleanup evidence.

Read [sources](references/sources.md), [authentication](references/authentication.md),
[triage](references/triage.md) and [accounting](references/coordination.md) before
collection. These references supply caller policy, not replacement workflows.
Before collection or campaign dispatch, verify `gh auth status --hostname <host>`.
If unauthenticated, ask the user to run `gh auth login --hostname <host>` and wait
before continuing. Recheck after they authenticate; do not open a GitHub browser
login or acquire another credential source.

## Configuration

Invocation instructions, not CLI flags: `REPOSITORY` defaults to the checkout's
canonical GitHub host/owner/repository; `CODEX_CSV` optionally supplies a snapshot;
`RESUME_RUN` selects an existing private campaign. A repository override must map
to the inspected checkout before assessment. Default sources are the four in the
description; never silently add Issues, advisories/private reports or new scans.

Copy of the Alpha roster with mandatory security bindings:

| ROLE | Model default | Reasoning default | Tier default |
| --- | --- | --- | --- |
| `TRIAGE` | `gpt-daybreak-blue-latest` | high | default |
| `OWNER` | `gpt-5.6-sol` | medium | default |
| `IMPLEMENTER` | `gpt-daybreak-blue-latest` | high | default |
| `SECURITY_IMPLEMENTER` | `gpt-daybreak-blue-latest` | high | default |
| `ESCALATED_IMPLEMENTER` | `gpt-daybreak-blue-latest` | high | default |
| `REVIEWER_A` | `cortex-hq/zai-org-GLM-5.3` | maximum supported | default |
| `REVIEWER_B` | `xai/grok-4.6` | medium | default |
| `SYNTHESIS_REVIEWER` | `anthropic/claude-opus-5` | medium | default |

Resolve `<ROLE>_MODEL`, `<ROLE>_REASONING`, `<ROLE>_TIER` using shared precedence and
route preflight. Owner/reviewer models are configurable. `TRIAGE`, `IMPLEMENTER`,
`SECURITY_IMPLEMENTER` and `ESCALATED_IMPLEMENTER` must remain Daybreak Blue,
including duplicate adjudication, validation and nested implementation calls.
An incompatible model override is a configuration conflict, not a fallback.
Inherit shared owner limits, candidate budgets and best-effort tier rules; do not
redefine them. Record resolved values and pass them unchanged on resume/handoff.

## Skill invocation boundaries

Discover installed skills by these names and read their entrypoints before invoking
them. Missing required skills block that capability; do not recreate their workflow
inline. External plugin paths are resolved from the active skill catalog, never
hard-coded to this author's machine. The parent campaign owns dispatch and grouping;
`triage-finding` runs inline inside its assigned Daybreak worker without nested
triage dispatch, dynamic tests, deduplication or source mutation.

| Invoke | Input | Required evidence / condition for continuing |
| --- | --- | --- |
| `lcm-memory` | Target project and bounded context question | Applicable context or recorded empty/unavailable result under repository policy |
| `codex-security:triage-finding` | Frozen sanitized supplied findings, exact source identities, checkout/SHA and private output destination; reuse its GitHub intake reference through authenticated `gh api` before freeze | One static verdict per source ID with evidence/proof gaps; no unrequested advisory intake or secret persistence |
| `codex-security:validation` | Specific unresolved claims requiring bounded validation, original IDs/evidence, isolated fixtures and private artifact destination | Evidence-backed result per claim or explicit remaining uncertainty; never treat setup failure as disproof |
| `playwright-cli` or available Playwright/browser skill | Exact source/repository, collect or approved disposition action, campaign auth contract and private destinations | Verified account/filter, complete export or source readback; login budget and credential isolation preserved |
| `procedural-development` | Grouped actionable/uncertain inventory, full S0 ledger, current verified runtime root, same logical run ID and recovery record, spent rounds, resolved roles, private tracker, `FOLLOWUP_CHANNEL=private-record`, source-resolution and LCM integration contracts | Invoke only after complete triage barrier; accept delivery only against caller audit |
| `codex-security:fix-finding` | From procedural-development's assigned Daybreak implementer: approved group plan, constituent claims, isolated worktree, acceptance and evidence | Complete fix/no-change/blocked evidence; return to existing owner/review lifecycle, no second coordinator |
| `codex-security:verify-fix` | Only when the user explicitly requests security-fix verification: findings and exact candidate checkout | Read-only per-finding fixed/still-vulnerable/inconclusive result; otherwise use the existing fix/review verification |
| `flock` | Only when shared LCM integration requires it: declared resource, authorized coordinator and protected operation | Existing skill's live ownership through verification; no invented campaign locks |

Use the existing skill's output contract, linking its private result from the ledger
instead of rewriting reports. A delegated skill's narrower boundaries remain in
force. Where it cannot meet this campaign's transport, privacy or model contract,
report the specific incompatibility and continue independent work only.

## Phase handoff

Freeze complete S0, triage every member, and finish centralized cross-source
grouping before any implementation. Evidence-backed dismissals may happen during
triage, after freeze and fresh source readback. Pass only actionable/uncertain
groups to `procedural-development`, keeping the full denominator privately.
The caller retains source dispositions and final audit; the invoked skill owns
remediation execution. Neither an empty queue nor a merged PR proves completion.
