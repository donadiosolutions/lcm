# Automated issue triage

New issues are queued for automated classification by the Codex issue labeler.
The labeler runs every five minutes, processes the ten queued issues with the
oldest creation timestamps, and reconciles the labels it owns with the issue's
title and body. Labels owned by people or other workflows are preserved. After
label reconciliation, issues whose live labels contain `bug` receive a second
Codex pass that searches for and closes only high-confidence duplicates.

## Add a managed label

The single source of truth is
`.github/codex/managed-issue-labels.json`. To support another label:

1. Create the label in the GitHub repository, including a concise description.
2. Add its name to one array in `managed-issue-labels.json`.
3. Open a pull request containing that one configuration change.

The workflow reads the description from GitHub and derives its model prompt,
output schema, validation allowlist, and reconciliation rules from the JSON
file. Do not duplicate the label in the workflow or policy module.

The groups have these selection rules:

- `categories`: one or more labels
- `topics`: zero or more labels
- `projects`: zero or more labels
- `priorities`: exactly one label

A label name may appear in only one group. The workflow fails safely if the
configuration is invalid or a configured label does not exist in GitHub.

## Queue and retry behavior

The issue-opened event creates the `needs-codex-triage` label if necessary,
checks the issue's current live labels, and adds the queue label together with
`p3-low` when no managed priority is already present. This single operation
ensures processors cannot see a newly queued issue without a priority.
Scheduled and manually dispatched runs share a non-cancelling concurrency
group, so only one processor runs at a time. A run handles at most ten issues,
oldest first, including an issue that closed while waiting in the queue; later
issues remain queued for a subsequent run.

The workflow validates the complete label-classification response before
changing any issue. It then processes each issue independently, adds and
removes only changed managed labels, and preserves every unmanaged label.

After reconciliation, the workflow refetches each issue and checks its live
labels case-insensitively:

- A non-bug is dequeued immediately. It is not searched for duplicate
  candidates and does not consume a second Codex request.
- A bug retains `needs-codex-triage` while the duplicate stage runs. This
  includes an issue whose manual `bug` label survives reconciliation and an
  issue that Codex has just classified as a bug.

If either stage fails, the affected issue's queue label remains so a later run
can retry it. Label application and duplicate candidate collection are isolated
per issue: successfully reconciled bugs continue through duplicate
classification and application even when a sibling issue fails either stage,
while each failed issue remains queued and the workflow reports the failure.
Missing or empty stage outputs safely skip downstream work. Removing the queue
label manually before either duplicate collection or an application step
cancels subsequent automated changes for that issue.

Codex reconciliation can replace the immediate `p3-low` default with the
appropriate managed priority.

## Duplicate bug handling

For each reconciled bug, the workflow uses GitHub's authenticated hybrid issue
search to collect at most eight older issue candidates from both open and
closed history. Pull requests, the source issue, and newer issues are excluded.
Issues already carrying the `duplicate` label are also excluded using their
authoritative live labels; a previously marked canonical that later receives
that label fails closed instead of creating a duplicate chain. Candidate
titles and bodies are bounded before they reach Codex.

The second Codex request is intentionally conservative. A candidate is a
duplicate only when it reports the same underlying defect. Related symptoms,
components, or goals are not enough. When equivalent open and closed candidates
exist, Codex must prefer the open issue. A closed issue is eligible only when no
equivalent open issue exists.

For a high-confidence duplicate, the workflow:

1. Adds the existing unmanaged `duplicate` label.
2. Comments `Duplicate of #N.` to create a visible link and backlink.
3. Closes the duplicate as **not planned**.
4. Removes `needs-codex-triage` last.

Every collected candidate's title/body fingerprint, state, state reason, and
live labels are checked again immediately before duplicate writes. Changed,
newly duplicate-labeled, or unverifiable candidates fail closed and leave the
source queued, preserving the evidence behind open-canonical preference. The
link comment contains a hidden workflow marker, so a retry cannot create
duplicate comments. If a partial run created that marker but did not finish
closing the issue, a retry refetches and validates the recorded canonical
target and finishes the marked closure even when the new model result is empty,
provided the source issue remains open and still has the live `bug` label.
Removing `bug` before application always dequeues the source without duplicate
actions, even when a trusted marker exists.
Conflicting or stale automated markers fail safely and leave the issue queued.
If a person closes the issue before application and no workflow marker exists,
the workflow preserves that closure without adding its own duplicate link or
label. A closed issue with a coherent trusted marker is dequeued after marker
and canonical validation, but is never closed again, preserving its existing
closure reason.

## Security and credentials

The classifier uses `gpt-5.6-luna` through the official OpenAI Codex Action.
The repository secret must be named `OPENAI_API_KEY`. An API key uses OpenAI
Platform API billing; a ChatGPT subscription session or credential is not used
by GitHub Actions.

The workflow deliberately separates both collection/classification stages from
their write-capable application stages:

- Collection checks out trusted repository policy code, reads public issue
  content, bounds it, and fetches live label descriptions without receiving the
  OpenAI secret.
- Each classification job receives only its generated prompt and exact JSON
  Schema. It performs no checkout, has read-only Codex permissions, drops
  `sudo`, and runs the Codex Action as the final step in its job.
- Each application job runs on a fresh runner without the OpenAI secret,
  validates the structured result, and performs least-privilege issue
  mutations.

Source and candidate issue titles and bodies are untrusted model input. The
generated prompts mark them as data and tell Codex to ignore instructions
inside them. GitHub label descriptions are repository-maintainer-controlled
guidance. Rotate `OPENAI_API_KEY` immediately if its exposure is suspected.

## Operations

Use **Actions > Codex issue labeler > Run workflow** to process the current
queue without waiting for the next scheduled run. An empty queue exits without
calling OpenAI. A queue with no reconciled bugs makes only the label
classification request. Workflow logs identify configuration errors, malformed
model output, missing issue results, stale fingerprints, conflicting duplicate
markers, and per-issue GitHub API failures.
