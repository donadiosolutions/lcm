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

## One-time rollout migration

The initial rollout requires a one-time operator pass. It is deliberately not
part of the recurring issue-triage workflow code.

Perform the migration in this order:

1. Prevent the stale workflow from running during migration, and snapshot every
   open and closed issue with its existing Issue type, Planning Field values,
   and labels.
2. Preserve existing Planning Field values, then backfill legacy labels:
   `p0-critical` to `Urgent`, `p1-high` to `High`, `p2-medium` to `Medium`,
   `p3-low` to `Low`, `bug` to `Bug`, `enhancement` to `Feature`, `chore`
   to `Chore`, and `question` to `Question`. Preserve `Epic` and resolve any
   conflicting legacy type labels against the reviewed inventory.
3. Set `Security status=Triage` on legacy security issues when the field is
   unset, then run the Terra enrichment pass.
4. Verify complete Issue type and Priority coverage for every open and closed
   issue and verify the intended security fields. Priority must be backfilled
   before the next stale run and before any legacy priority label is removed.
5. Mark `bug`, `enhancement`, `chore`, `question`, `security`, `p0-critical`,
   `p1-high`, `p2-medium`, `p3-low`, and every `prj-*` label as deprecated,
   then delete them only after verification succeeds.
6. Re-enable or allow the next stale run after the verified field backfill and
   label deletion complete.

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
