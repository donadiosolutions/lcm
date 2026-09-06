---
name: procedural-development
description: Use when executing a specified issue or bounded development inventory in a GitHub repository, directly or through a coordinating skill. Does not discover repository-wide Bug scope, assess an Epic journey, or launch work when merely authoring or reviewing skills.
---

# Procedural development

## Configuration

These are agent invocation parameters, not shell variables or CLI flags. Edit
defaults here or supply overrides with the invocation. Every role has the three
named parameters shown below; a model value may be a model name or exact route ID.

| Model parameter | Default | Reasoning parameter | Default | Tier parameter | Default |
| --- | --- | --- | --- | --- | --- |
| `OWNER_MODEL` | Astra | `OWNER_REASONING` | medium | `OWNER_TIER` | default |
| `IMPLEMENTER_MODEL` | Luna | `IMPLEMENTER_REASONING` | high | `IMPLEMENTER_TIER` | priority |
| `SECURITY_IMPLEMENTER_MODEL` | Daybreak Blue | `SECURITY_IMPLEMENTER_REASONING` | high | `SECURITY_IMPLEMENTER_TIER` | default |
| `ESCALATED_IMPLEMENTER_MODEL` | Astra | `ESCALATED_IMPLEMENTER_REASONING` | high | `ESCALATED_IMPLEMENTER_TIER` | default |
| `REVIEWER_A_MODEL` | GLM-5.3 | `REVIEWER_A_REASONING` | Max | `REVIEWER_A_TIER` | default |
| `REVIEWER_B_MODEL` | Grok 4.6 | `REVIEWER_B_REASONING` | medium | `REVIEWER_B_TIER` | default |
| `SYNTHESIS_REVIEWER_MODEL` | Opus 5 | `SYNTHESIS_REVIEWER_REASONING` | medium | `SYNTHESIS_REVIEWER_TIER` | default |

`MAX_ACTIVE_OWNERS = 7`; `WATCHDOG_MINUTES = 30`. User-authorized overrides
become recorded run-contract revisions, not implicit scope or budget changes.
The initial P2 budget remains three completed candidate rounds per item.

Resolve each parameter: explicit invocation override, then caller configuration
override, then this table. An inherited value is not an override. Pass the resolved
configuration unchanged to owners and leaves; do not reapply defaults on a nested
call. Apply the same routing rules to any additional caller-defined roles.

## Entry and boundaries

An execution invocation authorizes its specified work under the user's scope and
repository rules. Reading, authoring, or testing this skill does not authorize
implementation, issue mutations, worker launch, or environment replacement.

Read repository and applicable local instructions before substantive work. For a
non-primary local worktree, identify the primary and read its local instructions
too. Honor repository memory/context requirements and delivery policy. This skill
does not prescribe a package manager, coverage threshold, merge method, issue
type, shared service, or global installation procedure.

Use one root coordinator for the entire run. A caller invoking this skill retains
that root, its run identity, owners, and recovery record. Do not spawn another
coordinator or restart budgets. The hierarchy is root → item owner → implementer
and reviewers. If grandchildren are unavailable, the root dispatches leaves on
the owner's behalf and routes reports back to the owner. Respect runtime depth
and capacity limits; do not create user-owned tasks to bypass them.

The root orchestrates, handles user communication, and executes publication and
merge operations. It must not implement items, edit owner worktrees, adjudicate
implementation findings for owners, take over implementation, or replace a
reviewer. Owners coordinate their item through verified resolution; implementers
work in their assigned workspace; reviewers remain read-only.

The root reads both [coordination and recovery](references/coordination.md) and
[delivery and review](references/delivery.md), including owner dispatch, publication
payloads and the final live-head merge guard. Each owner and its leaves read the
delivery reference, with only applicable role instructions assigned in
self-contained dispatch briefs.

## Run handoff

Record this contract in workflow-local scratch before execution. These are named
pieces of evidence, not a required serialized API or new executable framework.

| Input | Required meaning |
| --- | --- |
| Identity | Repository, actual target branch and SHA, stable run ID, coordinator identity, record location; reuse on resume |
| Scope | Fixed item IDs, source links, acceptance criteria, existing ownership and completed evidence; no implicit additions |
| Readiness | Dependencies, required evidence for each edge, accepted edges, and current per-item disposition |
| Roles | Resolved model, reasoning and requested tier for each role; active-owner limit |
| Delivery | Repository checks, commit/PR/merge rules, documentation/release requirements, follow-up classification and item-resolution rules |
| Tracker | Identity and permitted checkpoint channel (comment, managed body block, or none); none means scratch only |
| Environment | Caller-defined startup, target-advance/post-merge convergence, watchdog and final-audit operations, executors and evidence |
| Exclusive resources | Exact resource value, supplied/discovered `flock` skill, protected operations and authorized executor; empty by default |
| Completion | Caller-specific final predicates, allowed blocked outcomes, and any authorization/criteria for tracker closure |

For direct invocation, construct the contract from the specified issue(s) and
repository policy. Default to no tracker, no environment operations and no locks
unless the task or repository requires them. An item is delivered only when its
acceptance, required checks and requested delivery endpoint are verified; blocked
items remain incomplete. Do not require native issue types or create an Epic.
Resolve material missing acceptance criteria through the root while progressing
independent work. Explicit draft-only or no-merge scope remains authoritative.

Never add follow-ups or newly discovered items to the fixed denominator. Explicit
scope revisions retain the original inventory, timestamp and prior evidence.
The caller's tracker/closure rules remain authoritative; this skill does not
independently close an arbitrary tracker.

## Routing and best-effort tiers

Resolve selected names using applicable local route mappings, the live dispatch
schema/catalog, and supported explicit overrides. Record exact IDs and effective
reasoning settings. A default list need not be exhaustive when explicit routes
are supported. A working proxy alone does not prove agent dispatch availability.
Do not invent IDs or treat reviewer unfamiliarity as evidence of unavailability.

Before issue mutation or worker launch, verify required model/reasoning routes
and dispatch mechanisms. If unavailable, report the concrete blocker and obtain
an explicit substitution rather than silently changing models, lowering reasoning
or omitting a reviewer. Honor runtime fork restrictions with minimal self-contained
briefs. Overrides change routing, not the number or independence of review roles.

Service tiers are preferences, never gates:

- `default` uses the provider/runtime default, normally omitting the tier argument.
- Request `priority` only through a supported control. If unsupported, unavailable,
  or denied for tier entitlement/availability, use the same model and reasoning
  with the default tier without requesting approval.
- Reconcile whether a dispatch was accepted before retrying without a tier.
  Do not duplicate or restart a successful worker just because its tier is hidden.
- Record requested and confirmed effective tiers separately. If unobservable,
  leave the effective tier unconfirmed; do not claim priority was applied.
- Lack of tier selection or verification never blocks preflight, dispatch, review,
  publication, recovery or completion. Model/transport/tool failures are still
  worker failures, not evidence of a clean review or an excuse to change models.

After a route failure, retry only the failed gate with the same selected route
and preserved evidence. Require a successful result before broad reuse. Reduce
optional tool exposure only when supported and without depriving reviewers of
needed evidence. Report a persistent external blocker while unrelated work runs.

## Caller-defined flock interface

Use `flock` only for declared exclusive resources and protected operations. Read
the caller-supplied or discovered skill and source its documented helper, then
acquire with `lock "$RESOURCE"`, preserving the caller's exact resource value.
Use its identity, shared runtime-directory, exit-status and release contract.
Do not copy its locking implementation or hardcode a resource name here.

Keep the same owning shell and descriptor alive across every protected tool call,
including required verification. A completed one-shot acquisition protects no
later call. Release through the skill's documented procedure on success or abort;
prevent long-lived background children from inheriting ownership. Do not hold
locks while waiting for unrelated workers, CI or reviews.

On contention, report observed holder metadata and defer only that operation.
On any acquisition failure, prohibit the protected mutation until resolved. Never
steal ownership, delete/replace a lockfile or kill its holder. Reacquire after
shell loss or resume; metadata and run records do not prove live ownership.
If a declared lock's skill or required mechanism is unavailable, keep that action
pending and continue unrelated work; do not invent an unsafe substitute.

No declared resources means no workflow locks. Do not invent reservations for
files, worktrees, tests, databases, reviews, publication or merges. Use isolated
fixtures and best-effort scheduling; application-internal correctness locks are
unaffected by this workflow policy.
