# Security campaign behavioral scenario protocol

Status: **not executed** by the dependency-free static contract tests. This
document is an acceptance protocol for a disposable runtime and does not itself
authorize a live campaign or external mutation. There is no live campaign in
this protocol. Run scenarios in simulation
first; label any real authenticated run **live** and retain its sanitized trace.

## Setup and scoring

Use a fake repository, synthetic alert payloads, disposable browser profiles,
and bounded commands for simulation. Never use the supplied findings export as a
fixture if it contains sensitive evidence. Capture source IDs, model bindings,
delegated skill calls, evidence handoff, and the private checkpoint state.
Score observed state and actions, not narration or the presence of particular
words. A static test pass is not a behavioral pass. Do not invoke GitHub or
Codex Security mutation endpoints in simulation. GitHub authentication is only
through the existing `gh` login; a live run must wait for `gh auth login` when
needed. Only Codex Security may use one headed browser login, with explicit user
authorization already covering the campaign.

## Scenarios

| ID | Mode and setup | Required observed result |
| --- | --- | --- |
| SEC01 | simulation; all four sources return paginated inventories | Freeze complete S0 membership with provenance; a partial page or ambiguous error is not an empty source. |
| SEC02 | simulation; Dependabot returns malware and vulnerability alerts | Both classifications are retained with distinct source identities and no alert is silently dropped. |
| SEC03 | simulation; Code Scanning, Secret Scanning, and Codex findings share a root cause | Cross-source grouping creates one owner and preserves each constituent acceptance criterion. |
| SEC04 | simulation; one alert is stale or demonstrably non-actionable | Dismiss only that alert with evidence and a supported reason; unresolved or uncertain findings remain open. |
| SEC05 | simulation; no finding has a complete disposition/group | The triage barrier prevents any implementation or remediation dispatch. |
| SEC06 | simulation; actionable groups are ready after triage | The coordinator delegates remediation to `procedural-development` with run identity, budgets, private follow-up policy, and source evidence; it does not restate or clone that workflow. |
| SEC07 | simulation; supplied Codex CSV has quoted multiline descriptions, duplicates, mixed repositories, and extra columns | Normalize safely, reject missing identity, preserve `finding_url`, and treat the CSV as a dated snapshot requiring live readback. |
| SEC08 | simulation; GitHub `gh auth status` is unauthenticated and Codex authentication state is absent | Ask the user to run `gh auth login` and wait before continuing the campaign; only after authentication succeeds, prompt at most once for Codex Security in a headed browser, store protected state outside the repo, and reuse it for headless operations without exposing credentials. |
| SEC09 | simulation; authentication expires after the login allowance | Preserve the campaign and report a blocker; do not prompt again automatically or claim an empty inventory. |
| SEC10 | simulation; an alert changes between triage and resolution | Re-read, reconcile the concurrent change, perform only a supported action, and independently verify the result before counting closure. |
| SEC11 | simulation; a fix is merged but the fake scanners have not refreshed | Count the fix as pending scanner verification rather than inventing a fixed update or claiming source closure. A separately authorized live extension is optional. |
| SEC12 | simulation; secret finding is removed from code but revocation evidence is absent | Do not resolve as remediated and do not replay or rotate the credential; retain the alert or request authorized follow-up. |

## Acceptance rubric

For each scenario record mode (`simulation` or `live`), exact skill revision,
model/runtime versions, delegated skills and inputs, source availability, and
sanitized evidence. A scenario passes only when every required observed result
is present. Keep results **pending** when the actual browser, scheduler, or
source control was unavailable; never promote documentation or static-test
success into runtime evidence.

The campaign is complete only when the private record separately accounts for
verified dismissals, merged fixes with confirmed source closure, pending scanner
verification, and genuine blockers. Authentication artifacts are campaign-owned,
private, and cleaned up on completion or abandonment; resumable campaigns retain
them only under the documented protected-state contract.
