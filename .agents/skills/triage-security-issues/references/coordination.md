# Private campaign accounting and completion

Apply [shared coordination](../../procedural-development/references/coordination.md),
[root lifecycle](../../procedural-development/references/root-lifecycle.md) and
[LCM integration](../../shared/lcm-development.md) directly. Invoke their required
skills when needed. This reference adds only security-source accounting.

## Identity and checkpoint

Use the [private storage contract](authentication.md). Retain the same logical run
ID, recovery record, S0, scope revisions and spent rounds on resume. Track the
current verified runtime root separately and preserve predecessor/successor handoff
evidence under the shared lifecycle. Authentication login counts survive handoff.

Use private records, not automatically published native Bug/Epic trackers.
Set the shared Tracker checkpoint channel to `none` (no GitHub checkpoint), with
the private recovery path recorded, and `FOLLOWUP_CHANNEL=private-record`.
Shared coordination still records private checkpoints and user-facing sanitized
status. Do not publish vulnerability details or private record paths in PR text.
Repository instructions requiring issue creation still apply: publish only a
sanitized minimum where required, retaining security evidence privately. If that
cannot satisfy both contracts, report the conflict instead of disclosing evidence.

Each alert key includes source kind, GitHub host when applicable, canonical
repository and native alert number or cloud finding URL. Numeric IDs alone collide
across sources. Dependabot classification is metadata, not a second identity for
the same alert. Retain the original IDs when calling existing security skills.

Record these additions alongside shared delivery/recovery evidence:

| Record | Evidence |
| --- | --- |
| Source coverage | Availability, exact filters, completed pagination/export counts, T0/TF, hashes, frozen target SHA, disabled exclusions or blockers |
| Finding | Namespaced identity/URL, source state/revision, sanitized claim, severity, assessment result reference, proof gaps, disposition and action readback |
| Group | Stable group ID, all constituent finding IDs, root-cause rationale, owner, per-member acceptance, dependencies/external ownership |
| Authentication | Provider, authorized account/workspace, owner, protected handle/path, headed login counts, reuse/cleanup status; no credential values |
| Follow-up | Private record with owner, acceptance, source/candidate/review evidence and PR link under shared delivery rules; outside S0 |

Keep alert counts separate from group counts: original S0 total; assessed;
actionable/uncertain; verified dismissed/already-resolved; grouped owners;
pending writes/scanner verification; merged/source-resolved; external blockers;
deferred follow-ups. Reconcile totals without removing closed or grouped members.
Later discoveries never silently expand S0. Refresh source state at shared
checkpoints and before closure; avoid duplicate mutations after lost responses.

## Final audit

For every S0 member, distinguish:

- Verified dismissal/non-actionability with evidence and source readback.
- Verified already-resolved state with current target evidence.
- Merged-resolved: complete group fix on default branch, each member's acceptance
  satisfied, and that source's closure independently confirmed.
- Pending scanner verification or source write: not resolved, even if PR merged.
- Genuine external blocker or verified external owner: reported explicitly, not
  counted as fixed by this campaign. Temporary parking is not terminal delivery.

Require shared exact-head delivery, process cleanup and applicable LCM environment
audit; verify private follow-up links, one accounted outcome per alert, group/member
acceptance, and auth cleanup or explicit resumable ownership. Disposition requests
awaiting provider approval are pending. Do not call all alerts resolved while any
source or member is unknown, pending or blocked. Report the remaining action,
source coverage, alert/group counts, merged PRs and verified target SHA without
exposing secrets or private evidence. Empty worker queues prove none of these gates.
