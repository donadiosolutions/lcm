---
name: procedural-development
description: Use when executing or resuming a specified issue or bounded development inventory in a GitHub repository. Not for repository-wide Bug discovery, Epic assessment, or merely authoring or reviewing skills.
---

# Procedural development

## Directives

Execution requires a user-authorized scope; reading, editing or testing skills
never authorizes workers, issue mutations or environment replacement. Read
repository/local instructions, including the primary worktree's local rules when
working elsewhere, and required project memory. Repository delivery policy applies.

Retain one root, run identity, recovery record and item budgets across callers and
resumes. The root owns orchestration, user communication, pushes, PRs and merges;
it must not implement, edit owner worktrees, adjudicate their findings or replace
reviewers. Each owner retains its item's planning, adjudication and resolution;
implementers use assigned workspaces; reviewers are read-only. If nested dispatch
is unavailable, the root dispatches leaves for their owner. Respect runtime depth
and total capacity; do not create autonomous user-owned tasks to bypass limits.

Keep the original inventory and denominator. Record explicit scope revisions with
timestamps and prior evidence; discoveries and follow-ups do not silently enter it.
Honor draft-only/no-merge limits and caller-specific tracker closure authority.

## Configuration

These are invocation parameters, not shell variables or CLI flags. Each role has
`<ROLE>_MODEL`, `<ROLE>_REASONING` and `<ROLE>_TIER` parameters:

| ROLE | Reasoning default | Tier default |
| --- | --- | --- |
| `OWNER` | medium | default |
| `IMPLEMENTER` | high | priority |
| `SECURITY_IMPLEMENTER` | high | default |
| `ESCALATED_IMPLEMENTER` | high | default |
| `REVIEWER_A` | maximum supported | default |
| `REVIEWER_B` | medium | default |
| `SYNTHESIS_REVIEWER` | medium | default |

Model bindings come from invocation or caller/local role configuration, not named
models in this skill. Resolve explicit invocation overrides, then caller overrides,
then defaults above; inherited values are not overrides. Pass resolved settings
unchanged to nested calls and apply these rules to caller-defined roles too.
`MAX_ACTIVE_OWNERS=7`, `WATCHDOG_MINUTES=30`; the initial P2 budget is **three
completed candidate rounds per item**. Record user-authorized revisions explicitly.

### Route preflight

Before issue mutation or worker launch, resolve exact model IDs and supported
reasoning through local mappings and the live dispatch schema/catalog. Explicit
routes need not appear in a default listing. Do not invent IDs, infer availability
from a working proxy, or infer unavailability from an unfamiliar model. Missing
bindings or unavailable required model/reasoning routes need a concrete blocker
and explicit substitution; never silently lower reasoning or omit a reviewer.

Use self-contained briefs with the assigned role, scope, workspace, evidence and
report contract. Follow the live schema's fork rules: where full-history forks
inherit model/reasoning and forbid overrides, use `fork_turns="none"` for an
overridden route. Dispatch by the actual tool recipient, not an execution wrapper.
A worker missing its brief requests it from its parent through `send_message`
when supported and performs no guessed assignment.

Tiers are preferences, not gates. `default` normally omits the tier argument.
Request `priority` only through a supported control; entitlement/availability
failure falls back to the **same model and reasoning** at default tier without
approval. Reconcile dispatch acceptance before retrying; hidden tier state never
justifies duplicating a worker. Record requested and confirmed tiers separately,
leaving unobservable effective tiers unconfirmed. Model/transport/tool failure is
not a tier failure or a clean review. Retry only the failed gate on its selected
route, preserving evidence; require success before broad reuse. Reduce optional
tools only when supported and without withholding necessary review evidence.

## Procedure

1. Read [coordination](references/coordination.md) and
   [delivery](references/delivery.md). Owners/leaves receive the applicable delivery
   instructions; the root reads both references in full.
2. Record the run contract below in workflow-local scratch. These are evidence
   fields, not a new serialized API or executable framework.
3. Preflight routes, dispatch mechanisms and declared resources; execute the shared
   scheduling and delivery procedures against the caller's readiness decisions.
4. Reconcile recovery evidence and audit the requested endpoint before completion.

| Contract | Record |
| --- | --- |
| Identity | Repository, actual target branch/SHA, stable run/root identity, recovery location |
| Scope | Fixed IDs, sources, acceptance, existing ownership and completed evidence |
| Readiness | Dependencies, acceptance evidence per edge, decisions and dispositions |
| Roles | Exact model IDs, effective reasoning, requested/confirmed tiers, owner limit |
| Delivery | Checks, commit/PR/merge rules, docs/release metadata, follow-up classification, source-resolution rules |
| Tracker | Identity and allowed checkpoint channel: comment, managed body block, or none |
| Environment | Startup, target-advance, watchdog and final operations, executors and evidence |
| Exclusive resources | Exact resource names, flock skill, protected operations and authorized executors |
| Completion | Final predicates, allowed blocked accounting and tracker closure authority |

For direct invocation derive acceptance and policy from the specified items and
repository. Default to no tracker, environment operations or locks unless required;
do not require native issue types or create an Epic. Resolve material missing
acceptance through the root while independent work progresses. Blocked is not
delivered; the requested endpoint and required evidence determine delivery.

## Declared locks

Only declared resources use workflow locks. Read the supplied/discovered flock
skill, source its helper and call `lock "$RESOURCE"` with the exact caller value.
Retain the owning shell/descriptor across all protected calls and verification;
a completed one-shot acquisition protects nothing later. Release on success/abort,
close ownership descriptors in long-lived children, and never hold locks while
waiting for unrelated workers, reviews or CI.

Contention defers only that operation; any acquisition failure prohibits its
mutation. Report observed metadata, never steal/delete/replace a lock or kill its
holder. Reacquire after shell loss/resume. If the mechanism is unavailable, keep
the action pending and continue unrelated work. Do not invent file, worktree,
test, database, review, publication or merge reservations. Isolated fixtures and
application-internal correctness locks remain unaffected.
