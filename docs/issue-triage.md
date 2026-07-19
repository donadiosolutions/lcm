# Automated issue triage

New issues are queued for automated classification by the Codex issue labeler.
The labeler runs every five minutes, processes the ten oldest queued issues, and
reconciles the labels it owns with the issue's title and body. Labels owned by
people or other workflows are preserved.

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

The workflow validates the complete model response before changing any issue.
It then processes each issue independently. For each successful issue it adds
and removes only changed managed labels, preserves every unmanaged label, and
removes `needs-codex-triage` last. If an issue fails, its queue label remains so
a later run can retry it. Removing the queue label manually before application
cancels automated changes for that issue.

Codex reconciliation can replace the immediate `p3-low` default with the
appropriate managed priority.

## Security and credentials

The classifier uses `gpt-5.6-luna` through the official OpenAI Codex Action.
The repository secret must be named `OPENAI_API_KEY`. An API key uses OpenAI
Platform API billing; a ChatGPT subscription session or credential is not used
by GitHub Actions.

The workflow deliberately separates collection, classification, and label
application:

- Collection checks out trusted repository policy code, reads public issue
  content, bounds it, and fetches live label descriptions without receiving the
  OpenAI secret.
- Classification receives only the generated prompt and exact JSON Schema. It
  performs no checkout, has read-only Codex permissions, drops `sudo`, and runs
  the Codex Action as the final step in its job.
- Application runs on a fresh runner without the OpenAI secret, validates the
  structured result, and performs the least-privilege issue-label mutations.

Issue titles and bodies are untrusted model input. The generated prompt marks
them as data and tells Codex to ignore instructions inside them. GitHub label
descriptions are repository-maintainer-controlled guidance. Rotate
`OPENAI_API_KEY` immediately if its exposure is suspected.

## Operations

Use **Actions > Codex issue labeler > Run workflow** to process the current
queue without waiting for the next scheduled run. An empty queue exits without
calling OpenAI. Workflow logs identify configuration errors, malformed model
output, missing issue results, and per-issue GitHub API failures.
