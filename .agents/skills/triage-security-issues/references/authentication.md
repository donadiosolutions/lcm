# Campaign authentication and private artifacts

Pass this contract to the invoked browser skill; do not implement a separate
session manager. Require already authenticated `gh api`: check `gh auth status`
for the target hostname before collection or dispatch. If it is unauthenticated,
ask the user to run `gh auth login --hostname <host>` and wait before continuing;
verify again afterward. Do not launch a GitHub browser login or inspect alternative
credential stores. Missing authenticated permissions remain a source blocker.
For Codex Security, prefer a verified cloud connector/API and reuse campaign-owned
browser authentication before prompting.

## Private storage

Create one owner-only campaign directory outside every Git checkout using the
existing private-directory facilities (directory mode 0700, file mode 0600, umask
077). Verify ownership, restrictive modes and absence of symlink redirection before
reuse. Separate sanitized evidence/ledger from authentication artifacts. Store only
paths/handles to auth in the coordinator record; never cookies, tokens or passwords
in ledger fields. Do not copy auth into worker homes, repositories, CI artifacts,
PRs, messages, traces, screenshots, browser console dumps or memory.

Suppress tracing, video, network-body capture and login screenshots while the user
authenticates. The user enters passwords/MFA directly. Do not inspect unrelated
browser profiles, keychains or credential stores. An already connected browser may
be reused only through its supported authorized surface; do not extract its secrets.

Raw exports may contain credentials and vulnerability details. Keep downloads in
the private coordinator directory, redact before worker dispatch, and remove raw
copies once normalized evidence is sufficient. Secret Scanning responses must be
projected in process before any persistence, as required by [sources](sources.md).

## Login budget and reuse

Track the Codex Security headed login count in the recovery record. At most one
headed Codex login, once for the logical campaign including resumes and coordinator
handoffs. All three GitHub sources use `gh`; there is no GitHub browser fallback.

When Codex login is necessary, explain the site/account, repository scope, campaign-only
storage/reuse and cleanup, then let the user consent by logging into the headed
session. Verify the final authenticated account/workspace and access before export.
Reuse that session's protected storage state or dedicated profile for subsequent
headless Playwright operations, including status readback and approved writes.
Use the browser skill's supported authentication mechanism; never manufacture
cookies or rely on undocumented session extraction. Persist refreshed state safely
when the supported mechanism requires it.

If authentication expires or headless reuse fails after that source's login,
record the blocker and continue independent work. Do not automatically request
another login, reset counts on resume, or loop through anti-bot/MFA challenges.
Only an explicit user revision can increase the budget. A missing headed surface
or nonportable auth state is a capability blocker, not grounds to bypass access.

## Lifetime

Retain protected authentication only for the active or explicitly resumable
campaign. On completion, cancellation or abandonment, invoke the browser skill's
session cleanup, close only campaign-owned browsers and remove their saved auth
artifacts using supported deletion operations. Verify cleanup without reading
secret contents. Retain sanitized audit evidence privately. On pause, record the
session owner, protected state location, login counts and resume status; on handoff,
verify sole ownership before reuse. Never kill shared browser/MCP processes.

[Playwright authentication](https://playwright.dev/docs/auth) documents storage-state
reuse and its credential sensitivity; use the installed skill for actual operations.
