# Automated issue triage

New issues are queued for automated classification with native GitHub Issue
types and organization Planning Fields. The workflow runs every five minutes,
processes the ten oldest queued issues, and preserves labels it does not own.
Issues whose live Issue type is **Bug** receive an additional conservative
duplicate check.

## Classification policy

The checked-in source of truth is
`.github/codex/issue-triage-policy.json`. It declares the exact Issue types,
Planning Field names and options, security-compatible Issue types, and
secondary labels the workflow owns. The Priority policy also explicitly lists
`staleExemptOptions`; these must be named Priority options and are the sole
source of stale exemptions.

The workflow resolves GitHub node IDs and descriptions dynamically. It fails
before inference if a configured type, field, option, or label is missing,
disabled, duplicated, or has drifted from the policy. IDs are never checked
into the repository.

General classification uses:

- Issue type: `Chore`, `Bug`, `Feature`, `Question`, or `Epic`
- Priority: `Urgent`, `High`, `Medium`, or `Low`
- zero or more configured secondary labels
- a security-candidate decision

Security issues may only use the `Chore` or `Bug` Issue type. Issue and field
descriptions are included in the model prompt and are the authoritative
decision boundaries.

Use `Question` for a focused request for clarification, guidance, support, or
an answer based on existing project knowledge. A question that requires an
investigation or spike is instead a `Chore` with the `research` secondary
label. Requests to change behavior remain `Feature`, and unexpected incorrect
behavior remains `Bug`.

To add a secondary label:

1. Create it in GitHub with a concise, unambiguous description.
2. Add its name to `labels` in `issue-triage-policy.json`.
3. Open a pull request containing the policy change.

## Queue and retry behavior

The `issues.opened` handler creates `needs-codex-triage` if necessary and adds
it to the issue. It also sets `Priority` to `Low` only when Priority is unset.
Issue Forms may supply an initial Issue type, but scheduled classification
reconciles it from the complete issue content.

Scheduled and manually dispatched runs share a non-cancelling concurrency
group. Each structured model result must cover every expected issue exactly
once and pass local allowlist validation before any write.

The workflow applies each issue independently:

1. Set Priority and, for a security candidate, `Security status=Triage`.
2. Set the Issue type.
3. Reconcile only configured secondary labels.
4. Run security enrichment when applicable.
5. Run duplicate detection when the live Issue type is `Bug`.
6. Remove `needs-codex-triage` last.

Removing the queue label manually cancels later automated writes. A failed
required mutation leaves the issue queued for retry. Missing security evidence
is different: the security pass deliberately keeps Triage and completes.

## Model routing

General Issue type, Priority, secondary-label, security-candidate, and
duplicate decisions use `gpt-5.6-luna` with high reasoning effort.

Security nature and status decisions use `gpt-5.6-terra` with high reasoning
effort. The dedicated pass runs only after Triage has been recorded.

Both classifiers use the pinned Codex Action in read-only mode. Their jobs
receive generated prompts and strict schemas, but no repository checkout and
no GitHub write permission. Application jobs run on fresh runners without the
OpenAI secret.

## Security enrichment

The collector attempts bounded reads from repository Dependabot, code-scanning,
secret-scanning, and repository-security-advisory APIs. It matches explicit
alert URLs, GHSA/CVE identifiers, dependency names, and
code-scanning rule IDs from the issue.

Only bounded metadata is retained. Raw secrets, secret locations, code
locations, private-fork data, dismissal or resolution comments, credentials,
and unrelated alert bodies are never placed in prompts, job outputs, or logs.
Collection follows each Security and Quality endpoint's pagination links,
including cursor-based Dependabot links, and stops after at most two 50-record
pages per alert state as well as the stricter per-source evidence cap.
Expected access denials and unavailable-feature responses from these APIs are
sanitized, bounded, and recorded in `accessIssues` instead of failing the
security collector. Terra may still run with the available evidence and those
explicit evidence gaps. When those gaps leave confidence low, the conservative
fallback keeps status at `Triage` and uncertain Security nature unset. These
expected best-effort degradations do not by themselves fail the pass or create
an endless retry.

Terra returns Security nature and status with independent confidence and
separate short rationales:

- Low-confidence or unknown nature is left unset.
- Low-confidence status remains `Triage`.
- `Affected` requires supported-version impact evidence.
- `Exploited` requires credible active-exploitation evidence.
- `Patched` requires evidence that a fixed project version has been released.

## Duplicate handling

Only issues whose live Issue type is `Bug` enter duplicate detection. The
workflow rechecks that type before candidate collection and immediately before
application. It searches bounded older open and closed issues and closes only
high-confidence duplicates.

For a duplicate, it comments `Duplicate of #N.` with a trusted hidden marker,
adds `duplicate`, closes the source as not planned, and removes the queue label
last. Candidate content fingerprints, states, state reasons, labels, and
timestamps are revalidated before writes. Retries resume a coherent trusted
marker but reject stale, conflicting, or duplicate-chain evidence.

## Rollout safety protocol

Use this protocol for either migration path below. The issue labeler and stale
workflow both mutate issue metadata, so they must not overlap an operator
migration.

1. Pause both the issue-labeler and stale workflows, then wait for every
   in-flight run of either workflow to reach a terminal state.
2. Snapshot every open and closed issue in the path's inventory, including its
   number, state, Issue type, every Planning Field value, and all labels. Record
   the snapshot time and highest issue number so issues created during the
   migration can be identified.
3. Perform the selected migration while both workflows remain paused.
4. Before final verification, rescan the repository and reconcile every issue
   created after the snapshot as well as every issue carrying
   `needs-codex-triage`. Add each one to the reviewed inventory, apply the same
   migration rules, add the queue label to any newly created issue that does
   not have it, and retain that label for normal classification after the
   workflow resumes.
5. Verify the complete, reconciled inventory. Deprecate and delete the path's
   legacy labels only after this verification succeeds.
6. Resume the issue-labeler first and dispatch its catch-up run. Confirm that
   the queued inventory drains without violating the verified field
   constraints, then resume the stale workflow.

## Initial rollout for new installations

An installation that has not completed the Planning Fields migration must use
this one-time operator path. It is deliberately not part of the recurring
issue-triage workflow code.

1. Create and enable all configured native Issue types, including `Question`.
   Verify that the `Question` description states the classification boundary
   above: investigation or spike work is `Chore` with `research`, behavior
   changes are `Feature`, and unexpected incorrect behavior is `Bug`.
2. Review every `question`-labeled issue. Map a focused request for
   clarification, guidance, support, or an existing-knowledge answer to
   `Question`; resolve other question-labeled issues individually. A security
   candidate must retain or receive `Chore` or `Bug` unless it is explicitly
   reviewed and declassified as non-security before it receives `Question`.
3. Preserve existing Planning Field values, then backfill legacy labels:
   `p0-critical` to `Urgent`, `p1-high` to `High`, `p2-medium` to `Medium`,
   `p3-low` to `Low`, `bug` to `Bug`, `enhancement` to `Feature`, `chore` to
   `Chore`, and the reviewed non-security `question` issues to `Question`.
   Preserve `Epic` and resolve conflicting legacy type labels against the
   reviewed inventory.
4. Set `Security status=Triage` on legacy security issues when the field is
   unset, then run the Terra enrichment pass.
5. Follow the rollout safety protocol's final rescan, then verify complete
   Issue type and Priority coverage for every open and closed issue and verify
   the intended security fields. Priority must be backfilled before the stale
   workflow resumes and before any legacy priority label is removed.
6. After verification, deprecate and delete `bug`, `enhancement`, `chore`,
   `question`, `security`, `p0-critical`, `p1-high`, `p2-medium`, `p3-low`, and
   every `prj-*` label. Resume and catch up the workflows only as specified by
   the rollout safety protocol.

## Question follow-up for already-migrated installations

An installation that completed the original one-time rollout before
`Question` became a native Issue type must use this narrow incremental path.
Do not rerun or rewrite the historical migration.

1. Use the rollout safety protocol to pause both mutating workflows and
   snapshot every open and closed issue that still has the `question` label.
   Review the inventory and identify issues outside the focused Question
   boundary.
2. Create the native `Question` Issue type if it is absent. Verify that it is
   enabled and that its description states the classification boundary used by
   the initial path.
3. For each reviewed `question`-labeled issue that meets that boundary, set
   only its Issue type to `Question`. Preserve its Priority, security fields,
   other Planning Field values, state, and unrelated labels. A security
   candidate must retain or receive `Chore` or `Bug` unless it is explicitly
   reviewed and declassified as non-security before it receives `Question`.
   Resolve all other reviewed exceptions individually instead of overwriting
   their existing Issue type.
4. Perform the protocol's final rescan for queued and newly created issues.
   Verify every issue in the reconciled inventory against the reviewed mapping
   and confirm that no Priority, security field, other Planning Field value,
   state, or unrelated label changed.
5. Deprecate and delete the `question` label only after that verification
   succeeds. Then resume the issue-labeler, run its catch-up, and resume stale
   in the order required by the rollout safety protocol.

## Stale issues

The stale workflow loads the checked-in triage policy and reads its configured
Priority field before invoking the pinned stale action. It temporarily marks
open issues whose Priority is listed in `staleExemptOptions`—currently `Urgent`
and `High`—with an internal exemption label, then removes those markers in an
always-running cleanup step. `blocked` issues remain exempt.

## Security and operations

Issue titles, bodies, alert metadata, and candidates are untrusted model input.
Prompts explicitly forbid following embedded instructions. Collection bounds
all text and result counts, and known credential, token, private-key, and
credential-bearing URL patterns are redacted before issue text enters a model
prompt.

The OpenAI Platform secret must be named `OPENAI_API_KEY`; GitHub Actions does
not use a ChatGPT subscription credential.

Organization Planning Fields are outside the repository-scoped
`GITHUB_TOKEN` permission boundary. Configure two fine-grained credentials:

- `CODEX_ISSUE_TRIAGE_READ_TOKEN` is used only by collection jobs. Grant
  repository Issues read access, organization Issue Fields read access, and
  read access to Dependabot alerts, code-scanning alerts, secret-scanning
  alerts, and repository security advisories.
- `CODEX_ISSUE_TRIAGE_WRITE_TOKEN` is used only by the write preflight,
  enqueue/application jobs, and every mutating step in the Priority-aware stale
  collector: creating and applying temporary exemption markers, running
  `actions/stale`, and removing those markers during the `always()` cleanup.
  Grant repository Issues write access and organization Issue Fields read
  access. It does not need permission to create, update, or delete organization
  field definitions.

Store repository-scoped fine-grained personal access tokens, limited to the
`donadiosolutions` organization and `lcm` repository, in the repository Actions
secrets with the exact names above. Never store a GitHub App user or installation
access token as either secret: those credentials are short-lived and require
per-run minting, which these workflows do not implement. Never use an
administrator or classic broad-scope token, and rotate the fine-grained tokens
before they expire.

When queued work exists, a dedicated non-model preflight authenticates the
write token and validates repository and organization Planning Field catalog
access before the first Luna classification. To prove repository Issues write
access without changing the intended label set, it verifies that the first
collected issue is still queued and idempotently re-adds its already-present
`needs-codex-triage` label. The token is not exposed to Luna, Terra, or
duplicate-classification jobs, and the preflight emits no outputs. Neither issue
triage nor any mutating stale step falls back to `GITHUB_TOKEN`. A missing or
invalid read credential that prevents core repository Issues or organization
Issue Fields access blocks general collection and Luna inference. Missing,
denied, or unavailable Dependabot, code-scanning, secret-scanning, or advisory
evidence is instead handled by the best-effort security path described above.
A missing or invalid write credential fails the preflight and blocks model
inference as well as issue, label, and Planning Field mutation. The stale
cleanup step uses the same explicit write credential even when it runs under
`always()`. GitHub write permissions remain job-local, and checkout never
persists credentials.

Use **Actions > Codex issue labeler > Run workflow** to process the current
queue. An empty queue exits without calling OpenAI. Logs report catalog drift,
malformed model output, unavailable security APIs, stale evidence, and
per-issue mutation failures without printing sensitive alert content.
