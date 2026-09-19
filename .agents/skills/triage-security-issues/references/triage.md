# Security triage and grouping

Apply the [entrypoint](../SKILL.md), [source rules](sources.md) and shared execution
contract. These rules compose existing security skills; they do not replace their
assessment methodology or output formats.

## Freeze and assess

Freeze S0 only after two consecutive complete inventories agree on source identities
and relevant states, with explicit confirmed-disabled exclusions. Record T0, TF,
source provenance, target branch/SHA and original denominator. API/CSV membership
changes or partial collection leave S0 unfrozen. Do not mutate alerts to stabilize
collection. An explicitly selected CSV snapshot scope must be labeled as such;
reading the same file twice does not prove current cloud completeness.

Dispatch Daybreak Blue triagers with bounded partitions of S0, original source
identities, sanitized claims, frozen checkout, instructions, private output location
and the shared worker execution brief. Invoke `codex-security:triage-finding` inside
each worker for static assessment only. Retain one result per input, including its
counterevidence, policy boundary and proof gaps. Separately invoke
`codex-security:validation` on specific claims where bounded reproduction materially
changes the decision. Do not turn this campaign into a new repository-wide scan.

Map existing skill results into campaign decisions without rewriting their reports:

| Assessment evidence | Campaign decision |
| --- | --- |
| Confirmed supported vulnerability | Actionable; retain severity and constituent acceptance |
| Needs review, missing setup or uncertain reproduction | Uncertain-needs-remediation; keep source open |
| Established obsolete, false-positive or inapplicable claim | Candidate for source-supported dismissal/resolution with evidence |
| Source already closed | Validate closure evidence against current target; preserve valid closure, investigate unsupported closure |
| Verified externally owned remediation | Record owner/PR and coordinate without duplicate implementation; assignee alone is insufficient |

A missing file, different commit, absent latest-scan finding or failed reproducer
is not sufficient counterevidence. A setup failure never establishes non-actionability.
During triage, immediately send justified disposition requests to the coordinator
for fresh read/write/readback under source rules. Do not wait for implementation to
dismiss established false positives. Pending source writes remain visibly pending.

## Cross-source grouping barrier

After every S0 member has an assessment, a Daybreak Blue adjudicator reviews the
whole sanitized inventory and reports group membership, root cause, evidence and
per-alert acceptance. This is a separate wrapper responsibility: `triage-finding`
does not deduplicate and must preserve its one-result-per-input contract.

Group findings across sources when they share the faulty control/root cause, or
closely adjacent causes admit one coherent fix and acceptance boundary. Similar
titles, CWE labels, advisory text or nearby lines alone do not establish grouping.
Do not group unrelated malware and application findings simply because both involve
dependencies. Preserve separate remediation groups when proof or ownership differs.
Keep every member ID in its group's acceptance; never dismiss alerts merely to
collapse duplicates or count an existing PR as fixing all members without proof.

The complete triage barrier requires all S0 members accounted for, completed
assessments, centralized grouping and one owner assignment per admitted group.
Uncertain claims have a concrete next investigation step. Missing assessment,
unreconciled identity or incomplete grouping blocks implementation. A source-write
permission blocker may remain explicitly pending while independent fully triaged
groups proceed; it does not count as a successful dismissal or completed campaign.

Invoke `procedural-development` once with the entrypoint's handoff contract.
That skill dispatches the Daybreak implementer, who invokes `codex-security:fix-finding`
for the approved group. Preserve all supplied model bindings in nested calls; an
extra investigator that performs security assessment uses Daybreak Blue too.
Reviewers remain in the configured review slots. Do not create a second planning,
review, escalation or publication workflow here.
