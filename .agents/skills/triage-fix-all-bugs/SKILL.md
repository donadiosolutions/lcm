---
name: triage-fix-all-bugs
description: Use when asked to coordinate triage and remediation of all currently open native GitHub Bug issues in this repository. Does not apply to fixing one issue or authoring this skill.
---

# Triage and fix all Bugs

Run a repository-wide Bug campaign in two sequential phases: **triage, then
remediation**. The root coordinates; dedicated workers investigate, implement,
and review. Apply each role's instructions only to the agent assigned that role.

An invocation authorizes the requested campaign, subject to the user's scope and
the repository's rules. Reading, editing, or testing this skill does not launch
the campaign or authorize its issue mutations, workers, or LCM replacement.

## Read by phase

The references contain the full procedure, including mandatory gates and event
payloads. Do not treat this entrypoint as a replacement for the applicable phase.

1. The root reads [inventory and triage](references/triage.md) and
   [coordination and completion](references/coordination.md) before starting.
2. Before dispatching triage, give each worker the shared contract here and the
   relevant triage instructions, its issue, the frozen inventory, and evidence.
3. After the complete triage barrier passes, the root and each owner read
   [remediation](references/remediation.md). Give implementers and reviewers the
   applicable sections and a self-contained role brief.
4. The root uses the final audit in the coordination reference before reporting
   completion. On resume, load the existing run record and reconcile live state;
   preserve S0, candidate history, and spent review rounds.

## Shared contract

- **Native types and relationships:** `Bug` and `Epic` mean native GitHub issue
  types with those exact names. Labels, title matching, Projects fields, and
  checklists cannot substitute for types or native sub-issue relationships.
- **Immutable scope:** establish S0 only after two consecutive, fully paginated
  native-Bug enumerations agree. Record T0, TF, parents, and the exact default
  branch HEAD. Later Bugs, including deferred P2s, never enter S0.
- **Existing ownership:** an S0 Bug already parented outside the run is
  `delegated-existing-parent`. Record it without mutation, reparenting, triage,
  or remediation. Keep it in the S0 inventory and denominator.
- **Triage barrier:** every S0 member must have a valid disposition, every
  individual triage worker must finish, and every suspected S0 duplicate group
  must finish centralized adjudication before remediation starts.
- **Seven productive owners:** at most seven Bugs actively undergo remediation.
  Park externally blocked work and promptly refill slots with actionable Bugs.
  Parking alone is not terminal. Avoid obvious overlap where practical; do not
  acquire exclusive source-file locks or delay ready merges for convenience.
- **Exact candidate:** commit and freeze each candidate SHA. GLM and Grok review
  independently; Opus reviews second using both reports; the owner adjudicates.
  Freeze implementation while reports are being gathered. Every head change
  requires this complete process again, including CI-only or conflict commits.
- **Severity and budget:** accepted P0/P1 always block. Accepted P2 blocks during
  the initial three reviewed candidate rounds; after round three, defer remaining
  P2s into linked native Bugs outside S0. P2 alone never triggers escalation.
  Escalation does not reset the P2 budget. P3 needs adjudication, not remediation.
- **Root boundary:** the root does not implement fixes, edit owner worktrees,
  perform implementation review, or replace a reviewer. Only the root communicates
  with the user and manages the main LCM installation and daemon.

## Execution integration

Read the repository's `AGENTS.md`, `WORKFLOW.md`, and applicable `AGENTS.local.md`
before work. For a non-primary worktree, identify the primary with
`git worktree list --porcelain` and read its local instructions too. Use the
available `lcm-memory` skill for project context.

Preserve repository delivery rules: signed commits when required, DCO signoff,
the PR template and assignment convention, relevant local tests, fresh exact-head
CI and full coverage gates, review-thread handling, documentation, and the
Changeset decision. Use a merge commit as required by `WORKFLOW.md`. Do not bypass
admission, force-push, or weaken checks to finish a campaign.

In this repository, the root/coordinator executes pushes, PR creation, and merges.
Bug owners remain accountable for their PRs through merge: they send the root the
branch, exact clean SHA, PR content, and the evidence applicable to that action.
The root verifies orchestration and admission evidence without reviewing the
implementation. References saying an owner publishes or merges describe that
owner's responsibility; the root executes those operations under `WORKFLOW.md`.

Owners emit `publication-requested` with branch, clean SHA, review/adjudication
record, local validation, and PR text. CI that requires a published branch is not
a prerequisite for this request. The root returns `pr-published` with URL and
head SHA. Owners emit `merge-requested` with that PR, clean SHA, and complete
exact-head CI, review, and follow-up evidence. Immediately before merging, the
root rechecks the live PR head against the declared clean SHA and required gates,
using an expected-head merge guard when supported. On a mismatch, return to the
owner for review of the new candidate; do not merge. Return `pr-merged` with the
verified merge SHA after confirming GitHub reports `MERGED`.

Publication requests include the originating Bug and a closing reference when
the fix fully resolves it. After merge, verify the source Bug is closed and the
fix is present on the default branch. If GitHub did not close it automatically,
the owner supplies the resolution evidence and the root closes it explicitly,
then reads back the state before recording `merged-resolved`. A merged PR with
an unresolved or still-open source Bug is not terminal; return incomplete fixes
to the owner instead of closing them for accounting purposes.

For P2 deferrals made before a PR exists, create the native Bug with the originating
Bug, candidate SHA, review context, evidence, and reproduction details first.
Record its PR link as pending; creating the follow-up satisfies the pre-publication
deferral gate. Add the PR link immediately after publication. A missing PR link
blocks merge and the final audit, so this ordering never loses the required link.
Use issue-body links or cross-references for these follow-ups, not native parenting
under the current campaign. Describe the distinct remaining finding so it is not
mistaken for the already-fixed originating Bug. If a follow-up is later fixed,
record the fixing SHA and verified resolution instead of leaving stale work open.

Establish the run's root as the Environment Coordinator before any global LCM
mutation. If another coordinator holds that responsibility, arrange an explicit
handoff; do not seize its lock or let subagents replace the global installation.
The root follows the repository's exact artifact installation and health workflow.

Use supported subagent mechanisms, within the runtime's depth and capacity limits.
The logical hierarchy is root → bug owner → implementers/reviewers. If the surface
cannot dispatch grandchildren, the root may dispatch those workers on the owner's
behalf and route their reports to that owner; ownership and independent reviews
stay unchanged. Do not create user-owned tasks merely to bypass subagent limits.

## Required worker routing

Resolve these model names against the **live** dispatch catalog; record the exact
model ID and effective settings in the run record. Do not invent a model ID or
claim a service tier that was not selected or confirmed by the runtime.
Use the active tool schema and supported explicit model overrides as authoritative
evidence; a default list is not necessarily exhaustive when the runtime permits
user-selected routes. Reuse a verified route recorded for the run. When several
routes provide the requested model/settings, select an available authorized route
and record the choice; ask only if the choice changes a user constraint or cannot
be resolved from runtime evidence. Reviewer unfamiliarity with the harness is not
evidence that a supported route is unavailable.

| Role | Model | Reasoning | Service tier |
| --- | --- | --- | --- |
| Triage, centralized duplicate adjudication | Luna | high | priority |
| Dedicated Bug owner | Astra | medium | priority |
| Default initial implementer | Luna | high | priority |
| Security-related initial implementer | Daybreak Blue | high | priority |
| Escalated implementer | Astra | high | priority |
| Independent first-pass reviewer | GLM-5.3 | Max | unspecified |
| Independent first-pass reviewer | Grok 4.6 | medium | unspecified |
| Second-pass reviewer | Opus 5 | medium | unspecified |

Both planning and every frozen candidate use the same GLM → Opus and Grok → Opus
review structure. GLM and Grok do not see each other's first-pass reports. Use
minimal, self-contained dispatch context; follow runtime fork restrictions.

Before launching the run, verify that required models, reasoning levels, service
tiers, and dispatch mechanisms are available. A runtime-confirmed fixed priority
tier is sufficient even when no per-call tier parameter exists. If a required
setting cannot be provided or verified, report the blocker before issue mutation
or worker launch and request an explicit substitution. Never silently substitute
models, lower reasoning, omit reviewers, or assume an unverified tier.

## Durable run record and recovery

Keep a run record in workflow-local scratch; keep the root Epic as the authoritative
high-level tracker. Record the repository, default branch, T0, TF, freeze SHA,
complete S0 inventory, hierarchy, all required counters, worker IDs and settings,
worktrees/branches, triage evidence, dispositions, candidate SHAs, completed review
rounds, adjudications, P2 follow-ups, PRs, current clean SHA, and LCM installed SHA
and health evidence. Keep tokens and credentials out of both locations.

Give the root Epic a stable run identifier and record the coordinator task/host,
scratch location, and a compact recovery checkpoint: S0 and freeze metadata,
owner/disposition map, current candidates, spent rounds, P2 state, review-evidence
links, PRs, and last verified LCM SHA. Update it at meaningful transitions. Avoid
publishing private host paths on a public Epic; use a shareable artifact location
or the host/task identity plus a relative scratch location. Preserve enough state
there for a successor to identify evidence without guessing paths or resetting
budgets. Inspect existing run Epics during preflight to distinguish a requested
resume from a new campaign. Reuse the same run on resume; an unrelated open Epic
alone does not block an authorized new run or authorize takeover of its members.

Reconcile issue state, native parents, existing Epics, worker status, and PR heads
before retrying interrupted mutations. Read back uncertain writes before retrying
so recovery does not duplicate Epics, follow-ups, closures, owners, or merges.
Never restart the inventory or round budget merely because the session resumed.
Recheck parent ownership immediately before attaching or dispatching an issue; if
it was claimed externally, preserve that hierarchy and record delegation.

Live external closures do not change S0. Read the closure reason and evidence,
then have the assigned worker validate the underlying disposition: an established
duplicate is `closed-duplicate`, an obsolete/fixed report verified against the
default branch is `closed-nonreproducible`, and a verified merged fix with resolved
issue is `merged-resolved` during remediation. Record who closed it and when; the
worker need not perform a second close. Unsupported automated closures are not
terminal evidence: investigate, correct the issue state when justified, or report
the specific external blocker. Do not invent a catch-all terminal state that
accepts an unverified closure. Delegated issues retain the no-mutation rule.

For every deferred follow-up, read back its native type and current resolution
at final audit. If automation has changed or closed it, inspect the evidence;
retain a valid resolution/canonical successor or correct an unsupported change.
Do not repeatedly reopen valid duplicates or resolved work to satisfy a counter.

If full enumeration keeps changing, cannot finish, or returns an error, leave S0
unfrozen and report the blocker. A partial response or fixed CLI result limit is
not an empty or complete Bug set. Do not mutate issues just to stabilize the set.
For a validated empty S0, create the requested empty tracking Epic, launch no
workers, and perform the normal final audit.

## Decision checks

| Situation | Required action |
| --- | --- |
| Two S0 workers each call the other a duplicate | Keep both open pending centralized adjudication |
| Reproduction is inconclusive | Keep open as `uncertain-needs-remediation` |
| Round three ends with only accepted P2s | File linked native Bug follow-ups; do not escalate |
| A clean head gains one CI-only commit | Invalidate cleanliness and review the new SHA fully |
| No active owners, but an S0 Bug is parked | Reconcile/resume or establish a genuine external blocker; not completion by itself |
| A worker finishes between watchdog checks | Handle the event immediately and refill available slots |

For example, if S0 contains four Bugs, one is delegated, one closes during triage,
and two merge, all four are terminal. Two deferred P2 follow-ups remain separate:
the denominator is still four. Completion also requires the final hierarchy,
default-branch, exact installed LCM, and daemon-health audit.
