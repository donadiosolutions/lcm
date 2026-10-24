# @donadiosolutions/lcm

## 2.0.0

### Major Changes

- c893dd0: Remove Node.js 22 support and declare Node.js 25.4.0 as the supported runtime.
  Installing on Node.js 22 now reports an `EBADENGINE` mismatch, which npm
  enforces as a refusal only when `engine-strict` is enabled and otherwise
  reports as a warning, so the unsupported runtime is stated at install time
  instead of failing later at runtime. The previous `>=22.12.0` floor was never
  functional: `node:sqlite` does not exist on Node.js 22.12 without
  `--experimental-sqlite`, which the CLI never passes. Node.js 22.13 through
  22.15 do provide `StatementSync.iterate()` but still lack
  `DatabaseSync.isTransaction`, which production code calls without a fallback,
  so no Node.js 22 release below 22.16 could run LCM as written. CI now runs the
  coverage gate on the declared floor so the supported runtime is exercised
  rather than assumed.
- 5d38673: Resolve compact discovery source locators with one bounded project-level
  lookup instead of one native-transcript query per eligible conversation, so
  large projects no longer pay an N+1 query pattern or load transcript payloads
  that discovery never displays. A session whose provenance cannot be read now
  loses only its own source locator (#1338, source Bug #1283).
  
  BREAKING: NativeTranscriptRepository gains the required member
  listUnambiguousSourceLocators. The interface is exported from the public
  @donadiosolutions/lcm/storage/native-transcripts entry point, so an external
  implementation must add this operation to compile against this release.
- 9baea9a: Canonicalize MCP search layers to `episodic` and `promoted` (defaulting to
  both) and grep scopes to `messages`, `summaries`, and `both` (defaulting to
  `both`). Deprecated `semantic` and `all` inputs remain accepted as aliases.
  This is a compile-time breaking migration: the previously published required
  `SearchResult.semantic` field never matched runtime and is removed. Callers
  and typed mocks must migrate to the required canonical `promoted` field.
  Daemon/runtime responses continue to return only `episodic` and `promoted` and
  never include an own `semantic` key. The deprecated `semantic` and `all` input
  aliases remain accepted at the input boundary and are not advertised.
- 991d75b: Replace `lcm map` with unified machine registration and project identity commands, preserving local SQLite hashes while adding explicit PostgreSQL UUIDv7 project pairing and reimage recovery. Add `lcm postgres migrate` as the supported packaged administrator workflow for provisioning the PostgreSQL schema.
- ce530ca: Replace component-oriented connector installation with one complete transport
  bundle per agent. The former `--type` option is removed; use
  `lcm connectors install <agent> --transport cli|mcp` and remove a whole bundle
  with `lcm connectors remove <agent>`. Explicit transport choices take
  precedence over stored `connectors.transports.<agent-id>` choices and registry
  defaults, while implicit defaults are not persisted.
  
  Claude Code, Qwen Code, and Zed default to MCP. Codex and every other agent
  default to CLI. Cline and Augment are CLI-only until verifiable MCP adapters
  exist. Codex's default CLI bundle is hook+skill and does not inspect MCP;
  explicit MCP uses native `codex mcp` commands. Guidance is transport-pure, and
  transport migration removes only exact LCM-owned MCP state where applicable.
  
  Migration examples:
  
  ```bash
  lcm connectors install codex --transport cli
  lcm connectors install codex --transport mcp
  lcm connectors remove codex
  ```
- fb81d39: Replace direct Claude Marketplace distribution with an npm-owned native Claude
  Code integration. Install or update LCM with npm, then run `lcm install`; the
  installer migrates recognized legacy Marketplace installations before
  registering native hooks, MCP, commands, and skills.
- 92dc218: Update the optional OpenAI peer dependency to OpenAI SDK 7.3.0.
- ff25c98: Make stats, status, pool diagnostics, local MCP statistics, and doctor report a shared sanitized snapshot for the selected SQLite or PostgreSQL backend, with bounded collection and explicit readiness/failure states. Omit unavailable metrics and content-bearing previews instead of exposing private data or reporting false zero totals.
  
  Make doctor observational throughout: it no longer starts or restarts the daemon, repairs settings or project maps, prunes orphan sidecars, or spawns an MCP server for a handshake. Use the reported explicit installation, connector, or daemon restart commands for repairs. SQLite diagnostics read committed WAL data without schema migration or durable content changes; necessary WAL/SHM read coordination may still occur.
  
  Show the same complete, safe readiness fields and fixed next actions across diagnostic text output, including failure snapshots. Distinguish aggregate and selected project scope with admitted UUIDs/local hashes, keep unknown selections unavailable, and report absent SQLite machine identity as not applicable without requiring registration.
  
  Reuse one bounded SQLite diagnostic child across projects and sidecars, preserving the whole-snapshot deadline. Keep an authenticated daemon reported as up when its status request fails, and identify the subsequent local diagnostic observation.
  
  Preserve independently observed daemon pool counts and the failure latch when the remote diagnostic probe times out or fails, after reauthenticating publication and configuration. Keep the backend failure classification and recovery action distinct from pool-count availability.

### Minor Changes

- ea9e005: Capture bounded file changes, subagent dispatches, answered questions, and explained plan revisions from native Codex `apply_patch`, `spawn_agent`, `request_user_input`, and `update_plan` tool calls.
- 99aeb4e: Restore LCM memory in Codex after compaction and into forked conversations. The
  Codex SessionStart hook now also runs for `compact` and `fork`, prefixes each
  restoration with an `<!-- lcm-restoration -->` line, and skips `resume`, `fork`,
  and `compact` when the session's own rollout already holds a restoration since
  the latest compaction or rollback. A Codex compaction restores recent summaries,
  promoted knowledge, and passive insights instead of orientation only, and a
  recent LCM summarization no longer strips a Codex `resume` or `clear`. The
  per-session restore lock is now released when the hook returns. Re-run
  `lcm connectors install codex` to update the matcher; Codex may ask to re-trust
  the changed hook.
- fac3921: Add an opt-in Codex PreToolUse hook that surfaces up to two relevant memories
  as advisory context before a shell command, `apply_patch` edit, or MCP tool
  call. It is off by default: set `hooks.preToolRecall` to `true` with
  `lcm config set hooks.preToolRecall true --json` and reinstall with
  `lcm connectors install codex`.
- 20f900b: Store transcript messages that follow a compaction event. `/ingest` and
  `/compact` no longer count compaction event rows as transcript messages when
  deciding what is new, so a session that was compacted keeps ingesting its later
  messages, and native linkage skips event rows.
  `postgresql-runtime-transcript-grants.sql` now also grants column-limited
  `SELECT` on `message_parts` so native linkage can recognize event rows. The
  conversation grants' table `SELECT` on `message_parts` already covers that read
  and runtime readiness, so these column grants are the least-privilege delta for
  a role without that table `SELECT`; re-applying the transcript script is
  harmless and not required.
  
  Custom `ConversationRepository` implementations must add the new required
  `getTranscriptSlotSnapshot` method, which returns the session-wide transcript
  row count and the compaction event rows with their slot markers.
- d81bc09: Add the migration activation orchestrator: the cutover that switches one
  verified, activation-eligible SQLite generation to its PostgreSQL destination.
  Activation re-reads every precondition live before it changes anything (the
  manifest and its verification report, the held maintenance window and writer
  quiescence, the project's fenced lease, single-project stored-data coverage,
  the destination identity, project-map and copy bindings, a fresh destination
  census, and the authenticated target health), and a failed check is a refusal
  that begins no effect. Once the checks pass it records durable evidence in a
  fixed order (the sealed publication artifact, the generation link, the
  activation epoch, attempt and witness, the witness and selection bindings),
  publishes the PostgreSQL selection through the same coordinator rollback
  uses, stores an immutable activation report and settles the manifest active.
  Every step is resumable after a crash: a retry classifies the durable state
  it finds and rolls forward, never re-mints an attempt a selection already
  carries, and reports whether the publication is known to have been applied as
  yes, no or unknown rather than guessing. A maintenance window entered from
  PostgreSQL (a rollback window) is foreign to activation and is refused. A
  non-predictive preview describes the durable state without taking locks or
  touching PostgreSQL. Activation connects as the transfer role that copied and
  verified the generation (its settings are supplied for both settings fields)
  and admits the target through the transfer readiness check; it does not prove
  that the daemon can start. The operator applies the runtime grants, revokes
  the transfer grants and then starts the daemon, as docs/migration-cutover.md
  describes. There is no operator-facing command for this yet; it ships as an
  internal capability that #627 will expose.
- ae9bb86: Add the `lcm migration` command group for the reversible SQLite-to-PostgreSQL
  cutover: `plan`, `dry-run`, `apply`, `resume`, `verify`, `report`, `abort`,
  `activate` and `rollback`. `plan` previews the next migration generation without
  mutating anything; `dry-run` checks the SQLite source in isolation; `apply`
  captures the source, mints a migration manifest, and copies the captured data to
  PostgreSQL; `resume` runs the one step a held generation is waiting for and stops
  at the next checkpoint; `verify` verifies a copied generation against PostgreSQL,
  finishes a pending verification from persisted evidence, and confirms a verified
  one; `activate` switches a verified generation to PostgreSQL and releases the
  maintenance hold; `rollback` returns an activated generation to SQLite; `report`
  is a read-only account of one generation that names the command to run next,
  shows the activation and rollback evidence, and checks whether a daemon needs a
  restart; `abort` is the recovery exit from a held attempt and is safe to repeat.
  
  Every command that acts on an existing generation asks one router which command
  owns the state it is in, so a command that does not own it refuses and names the
  one that does. `activate` and `rollback` each need `--confirm-generation` and
  `--confirm-backend` (`postgresql` and `sqlite`), their `--dry-run` never exits 0
  because it cannot evaluate the checks that decide the outcome, and their exit
  codes are a closed table: an interrupted activation is exit 6 (run it again), and
  a running daemon that still holds the previous backend is exit 8. `apply` no
  longer creates the local project map entry or the destination PostgreSQL project
  until its `--confirm-generation` matches, and never creates either while a hold
  exists.
  
  **`activate` runs under the PostgreSQL transfer role, so swap the grants before
  starting the daemon:** add the runtime grants to the daemon's runtime role, then
  revoke the transfer grants. `rollback` refuses while any other project is
  remotely bound, because the backend selection is global.
  
  See `docs/migration-operations.md` for the full operator runbook, including the
  exit-code vocabulary, refusal reasons, the JSON envelope, the daemon-presence
  policy, and what this command group does and does not protect against.
- 02aa46d: Add pool, migration, extension, and queue health families to the PostgreSQL
  backend diagnostic snapshot shown by `lcm stats`, `lcm status`, and
  `lcm doctor`. Each family reports its status, a health of healthy, degraded,
  or unavailable, the fields it could not observe, and a fixed next action. A
  degraded family raises a healthy snapshot to degraded.
- 29c8179: Add a curated `@donadiosolutions/lcm/storage/postgresql` production factory for explicit programmatic callers, with eager PostgreSQL 18 schema, exact extension ownership, hardened least-privilege readiness, publication-admitted cross-machine project identity, and deterministic lifecycle handling.
- 631481b: Extend automated issue triage to identify, link, and close high-confidence duplicate bug reports.
- e8d159f: Expose bounded, reset-aware PostgreSQL query statistics through the shared stats, status, MCP, and doctor diagnostic snapshot without reading or emitting statement text.
- 2f4e59f: Support Changesets beta releases with Codex-generated, pull-request-linked draft GitHub notes and publish npm only after a maintainer publishes the draft.
- a8b0dc0: Record and recall Codex subagents as their own sessions. The Codex hook
  connector now registers `SubagentStart` and `SubagentStop`, so a subagent
  receives project memory when it starts and its rollout is ingested under its own
  thread id when it finishes. Subagent tool events and compaction snapshots are
  keyed by that id instead of the shared tree session, so they no longer mix into
  the parent conversation, and parent-authored delegation prompts are not stored
  as user decisions. A forked subagent's rollout no longer re-stores the parent
  history it inherited when Codex records where the subagent's own history
  starts. Run `lcm connectors install codex` to register the new hooks.
  
  Each subagent conversation also records its immediate parent session in a new
  nullable `conversations.parent_session_id` column on SQLite and PostgreSQL
  (PostgreSQL migration 0009), filled once from the subagent's rollout and kept
  by portable transfer. This changes the portable schema digest, so transfer and
  migration artifacts produced by an older release fail closed with
  `incompatible-schema`; finish or abandon in-flight transfers before upgrading.
- d76ed97: Save Codex memory when a turn is interrupted or a session ends. The Codex hook
  connector now also registers `Interrupt` and `SessionEnd` hooks that run
  `lcm session-snapshot --client codex --terminal` within Codex's three second
  limit. The command only hands the transcript to the already running, verified
  daemon (it never starts or repairs one, compacts, or promotes), exits 0 with no
  output, and records a short reason in the hook error log when it could not hand
  the save over. The daemon accepts the request on the new authenticated
  `POST /ingest/terminal` route, answers before any storage work, and ingests the
  transcript after the hook has exited, combining closely spaced requests so the
  newest tail is read once. Reinstall the connector and approve the two new hook
  definitions in Codex to enable them.
- e5bcefc: Add bounded manual compaction concurrency with replay ordering, dry-run
  validation, invocation leases, and drain-safe cancellation diagnostics.
- 3cd1bd6: Add `lcm migration <command> --set` operations to prepare, activate, inspect, resume and roll back every project in a home through one fenced cutover. Set previews and per-member reports retain the existing JSON envelope and exit classes; single-project commands keep their behavior.
- 9b3f706: Add durable, versioned local passive-event envelopes; staged PostgreSQL inbox delivery, fenced completion, retry, quarantine, exact replay, and crash-safe acknowledgement/pruning; and operator status, validation, quarantine-inspection, and replay commands while keeping hooks fully local and offline.
- 95a8890: Add the internal bounded SQLite-to-PostgreSQL migration copy and resume API.
  Authenticated snapshots, a project-wide database lease, exact transfer receipts,
  and durable local effects keep retries from duplicating data or advancing local
  progress ahead of a proven commit. Copy completion preserves SQLite selection
  and maintenance; verification and activation remain separate operations.
- 5797f91: Add the checksum-sealed reversible-migration manifest, legal transition protocol, and crash-recoverable private revision journal used by SQLite/PostgreSQL cutover workflows.
- 842104b: Launch managed systemd and launchd daemons through a bounded clean environment so ambient manager variables cannot override staged credentials. Consume authenticated launchd credential files once and retain their immutable in-memory startup snapshot for in-process configuration reloads.
- 90a10e4: Manage daemon recovery through the current user's systemd or launchd service
  manager, recreate normally idle services on demand, preserve the tri-state
  no-response boundary, and provide canonical doctor, restart, and connector
  repair guidance instead of offline process recovery.
  
  Foreground or detached compatibility daemons are not eligible for automatic offline force recovery: if they stop returning HTTP responses, `lcm daemon restart` refuses and gives operator/manual recovery guidance instead of signaling or replacing the process.
- f6b40df: Route CLI retrieval, compaction discovery, transcript import and version 1 knowledge transfer through the configured SQLite or PostgreSQL backend. Preserve clean JSON output, authenticated project bindings and atomic retry of knowledge imports. Native imports now retain scrubbed transcript records with message links and checkpoints on both backends.
  
  Add production canonical SQLite and PostgreSQL transfer adapters with bounded preflight, durable batch receipts, resume validation and complete SQL readback. SQLite recovery archives expose typed native transcript, checkpoint, instruction and passive-event reads. Snapshot creation, migration fencing, cutover and archive activation remain separate operations.
  
  Keep publication admission held throughout selected CLI storage work and cleanup. Retry only before project preparation starts, so a later failure cannot automatically replay committed work.
- 8cd22b8: Publish the versioned backend-neutral portable record stream compatibility
  contract and its operator/adapter documentation as groundwork for later
  import/export and migration workflows. This does not activate CLI, cutover, or
  runtime backend routing.
- 12cc03f: Add `storage.postgresql.snapshotIdleTimeoutMs` (default 300000 ms) so a
  portable transfer's read-only snapshot transaction has its own
  idle-in-transaction bound, independent of `statementTimeoutMs`.
  
  This setting does NOT relax any protection: it bounds only the longest
  single idle gap between statements inside the snapshot, because
  PostgreSQL resets that timer every time the snapshot issues a query. A
  live transfer that keeps reading, however long it takes overall, is
  never killed by this setting; only a snapshot that genuinely stalls or
  is abandoned for longer than the bound is reclaimed, exactly as before,
  just measured against its own correct bound instead of the connection's
  much shorter statement-execution bound.
  
  Previously the snapshot's idle-in-transaction bound was derived from
  `statementTimeoutMs`, so a healthy portable cross-backend transfer whose
  snapshot merely sat open between reads for longer than that
  statement-scale duration could be killed by PostgreSQL (SQLSTATE 25P03)
  for doing exactly what a snapshot is designed to do, and the transfer
  would fail with a sanitized `source-unavailable` error. Separating the
  two bounds fixes that false-positive kill. The new setting is optional
  on the public `PostgreSqlConnectionSettings` type, so this change is
  additive, not breaking.
  
  A genuine idle-kill (or a connection actually torn while the snapshot
  was idle) is now classified as retryable `source-unavailable` instead
  of non-retryable `source-invalid`, and `PortableStreamError` gains an
  optional, non-serialized `cause` carrying the already-sanitized
  underlying storage error, so operators can see why a retry is
  recommended without exposing raw driver detail in logs or JSON.
- 6fac804: Activate verified PostgreSQL project-storage routing for the daemon and MCP
  paths, including bounded cancellation, shutdown cleanup, and fail-closed
  identity and backend errors.
- 87d5179: Add secure SQLite/PostgreSQL backend selection and PostgreSQL connection configuration, while retaining SQLite as the zero-configuration default.
- da03d2d: Add staged PostgreSQL promoted-memory, recall, redaction-administration, and session-coordination repositories with SQLite metadata parity, atomic scoped purge, least-privilege grants, and shared conformance coverage.
- b4a0ea9: Add reversible migration rollback: reverse a completed PostgreSQL
  activation back to SQLite. When PostgreSQL was activated but never written to
  since, rollback flips the active backend selection back to SQLite
  without copying any data. When
  PostgreSQL has been written to since activation, rollback builds a
  fresh SQLite generation from a fenced PostgreSQL snapshot, verifies
  it independently before installing it, and preserves the prior live
  database and the original pre-migration snapshot untouched. The
  rollback publishes the SQLite selection through the same coordinator as
  activation, refuses while another project is still bound to PostgreSQL (installation-wide
  rollback is tracked by #1544),
  and refuses a generation that never completed an activation, including one
  whose project was never bound to PostgreSQL or whose configuration was switched
  to PostgreSQL by hand (restore the configuration, or leave it with
  `lcm migration abort`). A rollback refused after it entered its maintenance
  window leaves PostgreSQL selected: the maintenance journal now records the
  backend a window was entered from, and an aborted window keeps that backend
  (an aborted activation still selects SQLite). Every step is resumable after a crash, including
  after the selection flips and during the coordinator publication: a retry never guesses which
  outcome already happened, an interrupted build never reuses a
  partial generation, and an incomplete or failed attempt is kept as
  evidence rather than deleted. The one exception is a prepared selection whose
  PostgreSQL destination was written out of band before the retry: it refuses
  fail-closed on every retry until #1529 adds an abort from that state. There is no operator-facing command
  for this yet; it ships as an internal capability that a future
  release will expose.
- 02abe68: Add authenticated, read-only SQLite migration snapshots with durable maintenance
  admission, exact passive-event receipts, queue cutoffs, and fail-closed recovery.
- b3ff6ba: Add the repository's triage-security-issues skill for existing GitHub and Codex Security alerts. It invokes existing assessment and delivery skills, groups related findings before remediation, requires Daybreak Blue security workers, and supports private campaign follow-ups and campaign-scoped Codex authentication.
- e2b4b63: Add staged PostgreSQL cross-machine transaction locks, fenced leases, final-write validation, fair passive-inbox claims, bounded cleanup, diagnostics, and least-privilege runtime grants.
- 64a019b: Add migration verification with canonical reconciliation evidence for the
  reversible SQLite-to-PostgreSQL cutover. A copied generation is now
  independently re-verified against the immutable source snapshot and the live
  destination inside a single fenced read-only window, producing a durable,
  content-addressed report before any activation step may consider the
  generation.
  
  Publication requires both a clean report (no recorded mismatches, including
  the public-probe sample class) and full reconciliation class coverage and
  full public-probe coverage; the persisted report records all three as
  `classCoverage`, `publicProbeCoverage` and `activationEligible` fields
  (the two coverage vectors are independent, so a genuine listing-ordering
  mismatch is never discarded just because the unrelated search probe could
  not evaluate that pass), so eligibility is provable from the artifact
  rather than assumed. Both coverage vectors are earned, not declared: a class
  or probe is marked as run only when the comparisons behind it completed in
  that pass, so a comparison that was never invoked leaves its bit false and
  the report ineligible. A report with mismatches is still persisted in full
  as operator evidence, but requires explicit abort and a new generation
  rather than an in-place retry.
  Reconciliation now includes a sequence self-consistency bound (an identity
  sequence's on-disk state must not allow the next allocation to collide with
  a copied row, distinguishing a privilege gap from a genuinely never-called
  sequence rather than collapsing both into the same refusal), and the
  step-5 public reads run two probes through the real PostgreSQL repository
  paths: an ordered-listing probe compared against the source's own canonical
  entries as identity and title pairs per millisecond (so two conversations
  that trade titles inside one millisecond are caught), and a search
  self-match probe that finds a sampled message by its own content through
  `lcm.search_v1`, sampled from a fixed-size early
  slice of the source's canonical order rather than the whole domain. If no
  sampled message can be found this way, the search probe is marked not-run
  in `publicProbeCoverage` and activation eligibility is refused for that
  pass rather than silently treated as a pass, since a search configuration
  wrong in a way no digest comparison can see is exactly what this probe
  exists to catch.
  
  Reconciliation also includes a foreign-key edge-set equality check (a
  `relation`-class mismatch names the child record whose reference no
  longer matches the source, catching a remapped-to-the-wrong-parent
  identity that an ordinary dangling-reference check cannot see) and a
  transfer-ledger check (a `ledger`-class mismatch when the destination's
  recorded transfer run, batch checkpoints or identity mapping disagree
  with the manifest or the census). The destination-schema witness now
  verifies the destination's own applied-migrations history rather than
  the currently running binary's compiled-in migration bundle, and a
  hand-maintained map of which columns have an identity sequence to bound
  is itself checked against the live schema on every run, refusing rather
  than silently under-covering a column a future migration adds.
  
  Verification cost scales with the row count in scope: the census reads and
  re-hashes each row individually, so its wall time is roughly linear in row
  count rather than a flat per-domain cost, and the census, sequence check and
  read-only guard all run inside one fenced window bounded by a single
  verification lease that is never renewed mid-window. See
  `docs/migration-cutover.md` for how to measure it with
  `pnpm run test:postgresql:census-cost` and for the lease sizing guidance.
  Verification also keeps the identity and dependency-edge sets of both sides,
  one record digest per destination record, and the full conversation listing,
  in memory at once; the same guide documents that memory bound.
  
  The verification lease is held until the report has been durably
  persisted, not released beforehand, so a second worker cannot acquire it
  and start a concurrent recomputation while this attempt's own persist is
  still in flight.
  
  Verification checks that it still holds that lease right after the census
  window closes and again right before the report is written, and refuses
  with a `lease-lost` error, writing nothing, when a check finds the lease
  lost. It does not renew the lease, and the lease can still expire during the
  local report write or while the manifest effect is begun and completed,
  which get no new guarantee.
  
  The sequence self-consistency bound is table-wide, not scoped to the
  project being verified: identity sequences are shared per table across
  every project, so a colliding row in a different project would otherwise
  go undetected whenever the verified project's own copy of that domain
  happened to be empty. The search self-match probe now requires a
  correlated match, not merely a non-empty result: it resolves each
  candidate's own destination-native key through the transfer ledger and
  confirms that exact key appears among the search results, so a search
  path that returns some unrelated but non-empty result can no longer be
  mistaken for a working self-match. The ledger check additionally
  reconciles the destination's recorded identity set against the census's
  own per-domain identities (not only their count and uniqueness), so a
  substitution that preserves cardinality and injectivity while recording
  the wrong identities is now caught.
- 5ab4b25: Unify linked Git worktrees under one local project, transactionally preserve and merge legacy worktree memory, and conservatively reconcile Codex transcripts from deleted managed worktrees.

### Patch Changes

- d08d3b6: Preserve fixed owner-preserving umask guidance when daemon start, restart, or a
  shared CLI consumer reports the matching managed lifecycle refusal.
- 02d0835: Correct the documented `lcm_expand` contract so it matches the shipped tool.
  The README configuration table and the agent-tool reference described a token
  cap and full source content that the registered tool never provides: the daemon
  expansion route passes no token cap and does not request raw source messages, so
  a response carries no message content, a child summary longer than 200
  characters appears as its first 200 characters followed by an ellipsis, and
  expanding a leaf summary yields an expansion entry whose children and messages
  are both empty. The
  `LCM_MAX_EXPAND_TOKENS` entry now names the unregistered
  `buildExpansionToolDefinition` helper it actually reaches, and the MCP tool
  description no longer promises full source content. The `lcm expand` command
  description and help text are corrected the same way, since that command posts
  to the same daemon route and returns the same child-summary snippets.
- bce07ed: Refuse private metadata publication earlier when a retained parent or temporary
  file changes, and report whether a rename completed or its publication outcome
  is unknown when topology changes after the rename attempt.
- 8c2bdd5: Keep the process-local worktree discovery cache on a monotonic elapsed-time
  clock so wall-clock corrections cannot extend or shorten its 1,000 millisecond
  TTL.
- a6c57d2: Preserve retained project and event topology diagnostics when reconciliation
  fails after a target database commit, while retaining rollback failures as
  secondary error evidence.
- cb390a0: Bound canonical worktree metadata by its serialized UTF-8 size, and preserve
  archived or completed reconciliation evidence when final publication fails.
- 1fbc7d8: Report the full number of sidecars skipped by bounded passive-learning scans,
  including files remaining after an in-flight timeout or cancellation.
- af72a56: Redact uppercase and mixed-case Slack webhook hostnames.
- 661765e: Redact glued single-slash file path tails in the first sanitization pass.
- 3ea92bb: Preserve publication admission callback failures while retaining ordered
  bootstrap-lock, home, and parent descriptor cleanup evidence and typed
  contention or publication-error classification.
- f2ddddb: Interpret timezone-less promoted-memory timestamps as UTC in prompt-search and
  restore age and recency decisions, keeping results consistent across hosts.
- 9ab2969: Fix passive promotion deduplication for exact content and PostgreSQL owner-wide
  provenance, while retaining the inserted event's remote source identity.
- 7f2192e: Refuse non-text or embedded-NUL promoted-memory rows during legacy worktree
  reconciliation instead of importing a truncated value, while preserving
  in-place repair and retry behavior. Honor completed source markers without
  requesting a source repair that the idempotent merge would skip.
- ac7c13c: Publish the PostgreSQL declaration dependency so strict TypeScript consumers can
  use the package root and storage subpaths without installing `@types/pg`.
- b4d2513: Refuse unsafe reconciliation journal roots during listing and bind mutating
  journal reads to the retained private directory's observed device and inode.
- aa26227: Correct prompt recall by scoring native matched-term evidence instead of incomparable backend ranks. Preserve full SQLite Porter matches and default PostgreSQL exact recall, with a four-point bonus only for whole normalized content/query equality and explicit native evidence diagnostics.
- 0c65cd1: Scrub secrets that span supported Claude and Codex native transcript text
  blocks before exact message linkage, while preserving the native record shape
  and failing closed when conservative redaction differs from parsed content.
- cb18b13: Document the third worktree-reconciliation refusal state. The recovery notes
  covered an uncommitted source fence that rolls back and a target refusal whose
  source fence may already be committed, but not the case where the completed
  marker is present at the read-only precheck and durably absent inside the target
  transaction. The source fence is committed by then, so the normalized source
  recheck refuses against an already-retired source: nothing is copied or
  truncated, but the documented in-place `UPDATE promoted` repair aborts against
  the retained fence and later runs refuse at the source guard. The privacy
  documentation now describes that state and states plainly that no in-place
  repair is supported, rather than implying the earlier procedure applies.
- 879d7ce: Restore normal configuration loading after SQLite migration maintenance is
  aborted or target selection completes. Continue to reject active maintenance,
  backend mismatches, changed configuration witnesses, and invalid journals.
- b1e991d: Fix passive promotion and event draining failing to acknowledge queued events
  after committing their memory or migration receipt. Reuse the current
  publication token for acknowledgement, retained-token preparation, and owned
  storage cleanup while keeping scrubber setup outside selected storage admission.
- 3fd9d40: Preserve hook publication failures when final root validation and descriptor
  cleanup succeed. Retain publication journal reasons and ordered evidence when
  cleanup also fails, and classify combined missing-evidence, contention, or other
  failures as unsafe storage. Keep PreCompact's initial unsafe-storage failures
  observable through its existing error logger. Reclassified finalization failures
  follow each hook's journal-error policy: some hooks throw, while best-effort
  hooks continue returning exit code 0.
- d1ff02b: Refuse unsupported SQLite migration capture and dry-run platforms before wrapper
  authority reads, append barriers, callbacks, or artifact effects.
- 28e977d: Index owner-scoped exact promoted-content lookup in PostgreSQL with a
  generated SHA-256 candidate column and partial btree index, keeping raw
  content equality as the residual collision guard. Applying the migration
  takes an exclusive schema rewrite and index-build window proportional to
  existing promoted-memory data.
- 030313f: Stop a queued local append from being forced to time out by a mutating
  passive-learning sidecar scan. Orphan cleanup now enters the local append order
  before it acquires publication consumer admission, so an append that started
  first completes and stays durable instead of waiting on a lock the scan is
  holding. The scan keeps one retained admission through its diagnostic snapshot,
  real close, eligibility check, and prune, and that admission no longer grants
  implicit append authority to nested tokenless appends, so an append started
  during close cannot write between the snapshot and the prune decision.
  Cancellation and the scan deadline are honored before the scan opens anything,
  reporting the sidecar as skipped, while unrelated publication contention
  remains a per-sidecar error that lets scanning continue.
  
  The sweep also keeps refusing to run while a backend migration holds
  publication, so it cannot delete a sidecar during maintenance.
- 34e7196: Preserve concurrent import metadata and retry identities by merging portable
  knowledge convergence into the current stored row instead of a stale import
  scan snapshot.
- e764a3e: Refuse malformed UTF-8 bytes in legacy SQLite conversation messages during
  worktree reconciliation so retries preserve the original source and target
  bytes for deliberate offline repair.
- 67d3c38: Admit local append work that already holds backend publication instead of
  queueing it behind an append that cannot proceed, so daemon promote-events
  sidecar scans complete rather than timing out under contention.
- 99c7a83: Serialize PostgreSQL promoted-memory deduplication decisions for knowledge
  import, so two concurrent imports of the same new content can no longer each
  observe an empty candidate set and both insert a separate active memory.
  Imports into one project now take turns rather than running side by side;
  imports into different projects are unaffected.
- c1e8387: Stop bundled Gitleaks detectors from monopolizing the daemon during native
  transcript backfill. Imported patterns collapse redundant nested lazy prefixes,
  and structurally verified required keywords now skip rules that cannot match the
  current text. Rules without a mechanical proof continue scanning in full.
  Secret-free strings also avoid a redundant residual scrub pass.
- caf6f1b: `lcm store` and the `lcm_store` tool now make the same deduplication decision
  as knowledge import and `lcm promote`. Storing content that already exists as
  an active promoted memory in scope returns that memory's id, with its tags
  unioned and its confidence kept at the maximum, instead of creating a second
  memory; two identical stores now yield one memory. New content still returns a
  fresh id.
  
  On PostgreSQL a manual store also takes the project-scoped deduplication lock,
  so it takes turns with a concurrent import or promote into the same project
  rather than racing them into a duplicate.
- 0676f31: Refuse to complete a PostgreSQL migration copy whose canonical rows changed
  after verification. Completion now re-reads every row the run wrote from
  inside the transaction that commits it, and holds the project write fence for
  that whole transaction, so another writer can no longer modify or delete a
  verified row in the window between the check and the commit. Completion reads
  the ledger in bounded pages and groups each page's rows so one read never asks
  for more than a batch worth of content, which costs a size read per group but
  keeps a large run from loading itself into memory while it holds the fence.
  Each ledger page is also bounded by the byte size of its native keys (#1461).
  Other writes to the same project wait for that completion to commit.
  
  Let installations that have already run a transfer apply the schema upgrade
  this check needs. The transfer ledger retains its rows, so the new required
  digest column is added nullable, backfilled for rows written before it
  existed, and only then made mandatory. A run that still carries one of those
  older rows fails closed instead of completing unverified.
  
  Report the readback failure that actually caused a migration settlement
  attempt to fail, instead of a stale error left over from an earlier retryable
  or ambiguous-commit attempt.
  
  Settle a migration whose rows moved after it completed. The content check
  belongs to the transition into the completed state; once that transaction
  commits and releases the fence, an ordinary project writer may change a row at
  any time. Reading a completed run back now re-proves identity, the run itself
  and its checkpoint chain without requiring the content to have stayed still,
  so a migration that did complete is no longer reported as a failed settlement.
- 585e8c1: PostgreSQL portable source creation and migration verification read canonical rows in bounded batches instead of one query per record.
- db67722: The exact-content dedup lookup added for PostgreSQL now runs on every
  backend. Knowledge import and passive promotion previously merged
  content with no searchable lexical terms (for example, punctuation-only
  text) into an existing active memory only on PostgreSQL; on SQLite,
  ranked search returned no candidates for such content and two identical
  writes produced two active memories. SQLite's exact-content lookup is
  indexed by project, with no lexical dependency, but still compares full
  content per active row in that project rather than using a content
  index the way PostgreSQL's does, and is now consulted the same way
  PostgreSQL's already was, within SQLite's existing source-scoped
  boundary. `lcm store` and `lcm promote` reach this same lookup on
  every backend as part of the separate dedup changes documented
  alongside this one.
- d4275a0: Compaction-driven promotion on PostgreSQL now deduplicates against the bound
  project's whole provenance and consults the exact-content lookup, as knowledge
  import and passive promotion already do. A promoted summary whose exact
  content is already an active memory merges into it even when ranked search
  cannot recall that content, so it is no longer stored twice.
- 0e0c2f6: Re-check PostgreSQL schema readiness inside the portable source's read-only
  snapshot so catalog changes between admission and snapshot are not exported.
- 9a3513e: Handle the asynchronous connection error that PostgreSQL emits when it kills an
  idle checked-out connection, for example through
  `idle_in_transaction_session_timeout`. Previously a query or transaction whose
  callback sat idle past the server timeout could raise an unhandled error and
  crash the process; the operation now fails with a storage error and the dead
  connection is discarded instead of returned to the pool.
- ae625a2: Refuse to complete a PostgreSQL migration copy whose destination gained
  canonical rows after verification. While holding the project publication
  fence, completion now compares, per non-identity domain, a database-side
  count of the destination's canonical rows with the run's transfer-ledger
  tally. A surplus refuses as `destination-unexpected-rows` and a deficit
  refuses as `verification-failed`, so a row committed by another writer
  between verification and completion no longer completes silently. Identity
  domains stay outside the comparison, and the post-commit readback of an
  already completed run does not repeat it.
- 15e797d: The backend publication coordinator refuses to record the guarded or released phases without a complete remote-guard provider when the publication has projects. Completed publication material is retained indefinitely by design.
- 27b5378: SQLite exact-content dedup lookups are index-backed. Result order is unchanged.
- b449698: Portable SQLite sources now detect same-timestamp writes after capture. A
  captured file whose timestamps are within two seconds of its authenticating
  read is re-hashed on every check instead of trusted from unchanged metadata.
- 838fbd4: Installed hook entrypoints (restore, session-end, session-snapshot, user-prompt,
  and `compact --hook`) no longer fail with exit code 1 when the backend
  publication lock is busy. They skip the CLI legacy-root migration preflight, and
  the hook dispatcher treats lock contention while loading the hook configuration
  as a best-effort exit 0 for compact, restore, and session-end. Session snapshots
  no longer load the configuration at all. UserPromptSubmit's durable local
  enqueue stays retry-required (non-zero exit) when its append barrier stays busy
  past the bounded wait.
- 087b4fa: PostgreSQL portable export and verification read conversation messages and
  record pages in batches, and batch memory accounting now includes record keys.
- 72e87e8: Treat an empty or non-string `metadata.projectId` in `lcm store` as the `manual` origin so it cannot merge into another origin's memory on SQLite.
- 8fcc3a4: Redact a path root that follows an ampersand after a file URL path in the first sanitization pass.
- 62d4023: Make the passive-event replication pass open the sidecar the sweep scanned,
  stop a pass from uploading new rows to a project that was relinked mid-pass
  while still finishing its work against that project, hold and retry an
  outbox whose close failed instead of opening a second one, and cancel an
  in-flight storage health check on daemon shutdown.
- 62709e3: Treat an existing journal-less backend-publication directory as unresolvable
  PostgreSQL publication evidence, bind a migration copy to the destination's
  PostgreSQL system identifier (manifests written before this change must be
  copied again to be verified), and accept only canonical positive decimal pids
  in the activation restart check.
- 8fd2224: Import prints the unbound-project remedy once per project when a mapped alias
  clone and the canonical checkout both have sessions. Docs describe direct
  export failure lines and correct the capture-cache residual cases.
- 6bd0dc8: Redact a path root that follows a question mark or equals sign after a file URL path in the first sanitization pass.
- d6d0787: Refuse migration copy writes, including lease acquire, renew and release, to a
  PostgreSQL cluster whose system identifier differs from the one recorded when
  the copy probed the destination.
- aafcaac: A passive event whose upload reached the previous remote project before a
  relink, but was not recorded locally, is now delivered to the new project, and
  the other events of its upload batch are no longer held back. When an upload
  fails and the new project lacks some of the rows, the previous project's copies
  are withdrawn, acknowledged, or kept quarantined as for other relinked rows, and
  the batch is uploaded once more without the rows that cannot go.
- f397350: `lcm mcp` now waits briefly for the managed daemon's own publication work at
  startup instead of exiting with a publication-busy error. Any other lock owner
  or unverifiable daemon still fails closed.
- 041f677: Redact a path root that follows a fragment marker after a file URL path, or that follows a URL scheme inside a redacted path, in the first sanitization pass.
- 6324d88: Authenticate the publication lock owner recorded when contention occurs, so
  `lcm mcp` startup after a daemon restart no longer exits when the daemon
  releases the lock before convergence can read it again. The retry stays within
  the existing two-second window, and contention on other locks, missing daemon
  identity, and foreign, malformed, stale, or unhealthy owners still fail closed.
- 5b15d3e: Drain a machine's whole ready backlog of PostgreSQL passive events in one
  replication pass instead of one event per pass, up to the batch size.
- 1e08c10: PostgreSQL read routes return a sanitized 503 instead of empty results when
  project storage or publication admission fails.
- 2b454ab: PostgreSQL daemon read routes (`/search`, `/grep`, `/recent`, `/describe`, `/expand`)
  no longer fail while the daemon's own publication work, such as a replication
  sweep phase, holds the publication lock. A read that contends retries once,
  waiting up to one second for a turn in the daemon's publication queue, and
  otherwise returns the sanitized `503`; contention and an expired wait are
  retryable, while a genuine storage failure keeps `retryable: false`.
- 0fd55ef: Re-running a migration rollback now completes it when its own backend
  publication was aborted by something else. The restored configuration and
  project map are checked against what the publication recorded, the destination
  and the activation authority are verified again, and the publication then
  resumes forward; a drifted destination refuses with the effect pending and the
  lease held.
- 6663b76: Interpret current Codex tool outcomes correctly. Passive capture now accepts the
  `Bash` tool name Codex emits for shell commands, keeps the legacy
  `functions.exec` names as aliases, and no longer treats a shell command as
  successful just because Codex reported no status: git and install commands with
  no structured status are stored as a `tool_outcome_unknown` observation, which
  is never promoted, reinforced or correlated as the fix for an earlier error.
  Codex MCP calls are recorded as before when the result is a success.
- fdc4fef: `lcm connectors doctor codex` now reports whether Codex can actually run each
  LCM hook (missing, disabled, untrusted, modified, or ready) instead of
  only checking that the hook is installed, and reinstalling the Codex hooks
  keeps your per-hook enable and trust choices and any explicit
  `[features] hooks = false`.
- e4d488c: Document the Codex lifecycle guarantees verified against native Codex 0.163.0
  sessions: which edges are verified, best-effort, not covered or unverified, how
  failures and context limits behave, and where to look when a hook does not run.
  Correct the Codex MCP bundle setup (register with `codex mcp add lcm -- lcm mcp`
  first) and document the `hooks.snapshotIntervalSec` Stop throttle.
- f984fd5: Make `lcm compact` report actionable per-session failures. Failed sessions now
  name the cause (lost daemon connection, rejected authentication, unavailable
  daemon, daemon error, or unbound project) and the next step instead of a
  generic "compaction request failed", without echoing raw daemon or provider
  error text.
- 9e8fec2: Name the condition code and source ordinal in native transcript linkage
  failures so logged ingest errors identify which record failed and why.
- 3d7dc06: Honor the documented `LCM_ENABLED=false` setting by making every native Claude and Codex hook a no-op, including the legacy `lcm compact` PreCompact command.
- 6bdc0e8: Reject FIFO and other special-file transcript paths without blocking the
  daemon. Native ingest and the pathname transcript readers used by compaction
  now open the file non-blocking and check that it is a regular file before
  reading, so a FIFO with no writer returns the empty-input result instead of
  hanging the request.
- b1032c3: Stop storing a Codex fork's copied parent history again. A fork that copied its
  parent's rollout now stores, and links in the native transcript archive, only
  the messages after its own settings event, in both `/ingest` and `/compact`.
  A session that was stored before keeps following the history it already holds.
- 54cfd9f: Daemon shutdown no longer closes storage while a cancelled background ingest is still opening a project.
- 72c0c4e: Treat Codex config.toml files with overflowing float values as invalid TOML, so
  doctor reports hook state as unknown and install leaves the file unchanged.
- 474b815: Make `lcm connectors install codex` stop, leaving `hooks.json` and
  `config.toml` untouched, when `hooks.json` is not valid JSON or repeats a key,
  instead of replacing it with only the LCM hooks. `lcm doctor` now also reports
  a `hooks.json` with a key repeated in the file, a group or a handler, or a
  non-integer command or MCP tool `timeout` or command `additionalContextLimit`,
  as unreadable.
- 6dfca1b: Report a fixed stderr line when the daemon does not acknowledge a Claude
  SessionEnd completion within its one-second wait, naming a timeout, an HTTP
  status, or an unavailable daemon, without changing the hook's exit code or
  stdout.
- 6eaaaf2: Document how to upgrade the Codex `SessionStart` matcher when the LCM restore
  hook shares its group with other hooks.
- 8ac9b96: Rollback no longer refuses local outbox events whose stored timestamp differs from the archive only in format.
- cc187d8: Let a migration verification of a project with no messages become activation
  eligible. The search probe previously reported not-run whenever the source had
  no message to search for, so an empty enrolled project could never pass. The
  probe now runs the production search once on a fixed query and, when it returns
  no rows while the source and the fenced destination census both report zero
  messages, records the public-search receipt. Projects with messages keep the
  correlated self-match proof unchanged.
- e4b83e5: `lcm migration apply` now carries a project's project-map aliases to
  PostgreSQL with the project, so a project with extra alias paths no longer
  fails the copy after the hold. It refuses with `alias-conflict` before the
  hold when the aliases cannot be minted exactly. A generation that an earlier
  version already held and failed stays on `resume`: abort it, then run a fresh
  `plan` and `apply`.
- 6963d7e: Route the two interrupted `lcm migration` activation windows (after
  `prepare-activation` completes and after the publication drive completes) to
  `activate` so it resumes them, instead of refusing every command with
  route-contradiction (exit 5).
- e8ede04: Fix cutover-set rollback sometimes failing to complete a member with "migration report timestamp is outside the effect boundary" when the clock advanced between the report timestamp and the completion timestamp.
- 5954c23: Accept a passive event the daemon already drained while PostgreSQL's inbox
  still lists it as pending when rolling back to SQLite, and refuse a genuine
  divergence before the rollback publishes anything.
- af1bf45: Deliver pending hook events that crossed a PostgreSQL cutover on the first
  replication pass, and let `lcm events validate` accept their migrated copies.
  A copy already in the project now matches the local event when they differ only
  in the textual form of the creation time or in a `previousEventId` that only
  the local side carries (values that both sides carry must still be equal). A
  copy that is still pending is applied once, and one that was already applied is
  acknowledged without a second apply, instead of failing the whole batch.
- a025f3f: Fix portable export and rollback of a PostgreSQL project whose passive-event
  inbox still holds rows that the replication pass uploaded. Those rows carry the
  local `previousEventId` pointer, which the export refused with
  `record-unrepresentable`, so the whole project failed to export. The export now
  accepts the pointer (absent, null, or a positive integer) and leaves it out of
  the portable record, as the SQLite source already does.
- f3de3ee: Let the authenticated `GET /health/observe` endpoint answer for a daemon that
  started on SQLite when the on-disk selection is PostgreSQL and the daemon's own
  environment lacks `LCM_POSTGRES_URL`, `LCM_POSTGRES_CA_FILE`, or the migration
  role. `lcm migration report` and an `activate` retry now report exit 8
  restart-required instead of exit 5 for that stale daemon; present values are
  still validated, and a daemon binary from before this fix still gives exit 5.
- b39f7f1: Rollback from PostgreSQL to SQLite now accepts local passive events that the replication worker delivered and whose PostgreSQL inbox rows it then pruned, instead of refusing them as events PostgreSQL does not hold.
- 02e8aee: Keep local hook appends and SQLite physical close operations ordered with
  immutable migration capture, and refuse capture when an enrolled canonical
  outbox is missing. Retry the one authenticated lock-owner disappearance race
  that can occur while a valid owner releases its lock. Keep SessionStart outbox
  pruning inside one composed consumer and append admission. Reuse the live
  request token for project close, and publish a registered migration identity
  only after its exact receipt epoch is durable.
- a8b17f9: Accept an optional lockToken on BackendPublicationCoordinator's
  prepareMaintenanceSelection, completeMaintenanceSelection,
  abortMaintenance, prepare, resume, abort and recoverPending, mirroring
  the existing enterMaintenance parameter. A caller already holding the
  publication lock can now invoke these methods without contending with
  itself. The parameter is optional, the untokened #locked branch is
  unedited, and the seven methods have zero production callers today, so
  omitting the token preserves today's behaviour exactly.
- 6065f98: Publish a least-privilege PostgreSQL incident runbook with bounded evidence,
  private restore and rotation procedures, and executable privacy canaries.
- 46f7cae: Clarify that MCP `lcm_grep` queries are interpreted according to the selected
  full-text or regular-expression mode.
- ea52ee3: Reject untrusted project-directory topology during admission and metadata
  publication, with descriptor-bound mode tightening for directories LCM creates.
- d7cc6a0: Bind coordinator recovery-material authentication to the locked publication-directory witness and fail closed on directory identity drift.
- 8553302: Correct the `lcm_grep` documentation to describe its response envelope, hit
  fields, timestamp serialization, and empty-response compatibility behavior.
- 4039d9b: Redact literal nested `file://` paths in URL query, fragment, and assignment
  values while preserving the surrounding URL text.
- 4114886: Validate `lcm expand` depth inputs as positive integers before project
  admission and document the matching CLI and MCP contract.
- d9f86cf: Converge a managed daemon's final backend-publication admission after startup
  when its initial passive sweep briefly holds the publication lock. The bounded
  retry is restricted to the exact authenticated child and fails closed on
  identity, credential, birth, health, timeout, or cancellation changes.
- b5503de: Keep nested `lcm connectors install` on ordinary root migration and
  connector-owned verification instead of applying the top-level installer's
  publication-convergence retry.
- 9600f82: Present lock-free installer configuration drift as a stable diagnostic while
  preserving the installer's fail-closed admission behavior.
- 50fbedd: Preserve explicit empty `grep --since` values so the daemon can reject them
  instead of treating them as an omitted filter.
- a14b202: Apply promoted search tag filters before the result limit so tagged searches
  return the requested number of eligible records.
- 37c3433: Redact literal `file://` paths after query and fragment value prefixes so error
  messages do not expose local paths embedded in wrapped URL values.
- 270ec0a: Preserve the original publication-lock contention when authenticated process
  birth or health probes settle after the shared convergence deadline, while
  continuing to fail closed without retrying unverifiable evidence.
- e1fca51: Document the current-versus-first publication contention reported by CLI
  inspection and installer retries after recognized deadline expiry.
- dd2ca47: Repair `memory.recent` to send an absolute project directory as `cwd`, making
  the existing `/recent` retrieval path reachable. Calls that supplied a project
  hash as `projectId` must migrate to the corresponding directory; hashes are
  not interpreted as paths and no ambient working-directory fallback is added.
  After project admission, existing HTTP 409 storage identity and HTTP 503
  PostgreSQL failures remain observable; invalid limits continue to return 400.
- d91c4e8: Reject non-object JSON request bodies for `lcm expand` with HTTP 400
  (`invalid request body`) before project admission. Literal `null`, arrays, and
  other JSON primitives now share that stable shape error; malformed JSON syntax
  keeps its existing server error behavior.
- 24836f7: Correct the expansion architecture documentation to match the daemon-backed
  HTTP, MCP, and CLI behavior and distinguish the unregistered helper's cap.
- ee53aff: Reject Codex configuration resolution with `AbortError` when the caller
  cancels during owned app-server teardown, after termination settles, instead
  of returning the validated endpoint or token-class default.
- 90fcaa6: Preserve fixed owner-preserving umask retry guidance when managed daemon
  lifecycle operations refuse startup after a newly created temporary directory
  loses required owner permissions.
- 4ab3793: Bound optional process-birth sampling during daemon startup admission so
  authenticated diagnostics retain part of the shared lifecycle deadline.
  Unavailable birth evidence still admits an otherwise authenticated daemon but
  does not authorize publication-convergence recovery.
- b23a590: Reject non-object JSON request bodies across daemon memory, lifecycle, stale
  review, and passive-event routes with HTTP 400 (`invalid request body`) before
  route effects. The `/recent` endpoint now rejects primitives that it previously
  treated as an empty request; empty bodies and malformed JSON syntax keep their
  existing route-specific behavior.
- 98c16a0: Add an optional absolute `cwd` to `memory.search` so callers can reach the
  existing project-scoped `/search` storage path. The daemon remains responsible
  for validation; omitted `cwd` keeps the existing empty-result behavior, and
  `projectId` is not treated as a project selector.
- a17e8a0: Retain authenticated reconciliation target directories through database,
  pattern, metadata, archival, and project-map publication boundaries. Block on
  directory identity or private-mode drift, and refuse unsafe snapshot cleanup.
- 5a15563: Expose the promoted-memory `tags` filter in the typed `memory.search` API.
- 7bab21c: Keep worktree-reconciliation lock retries bounded by monotonic elapsed time so
  wall-clock corrections cannot extend, shorten, or otherwise distort contention
  waits.
- 4b8544c: Cancel pending project opens when requests disconnect or the daemon shuts
  down, preventing cancelled reads and restores from returning false success.
  Cancelled project opens now use intentional cancellation errors, while
  `/promote` retains its existing cancelled-response (499) behavior for
  existing-mode cancellation.
- 1c2c9d0: Accept Codex process summaries when the authenticated Responses stream reaches
  its successful terminal event, even if Codex closes before HTTP transport EOF.
  Malformed, failed, incomplete, terminal-chunk suffix, and truncated streams
  continue to fail closed without requiring an exact Codex CLI version. Unread
  upstream bytes after the terminal frame are canceled rather than relayed.
- 26d2238: `lcm install` and `lcm doctor` repair can migrate the exact historical
  trailing-blank-line skill while unknown or modified collisions remain
  preserved and refused.
- f71889e: Retain backend publication admission through prompt-search surfacing metadata
  writes, and return a sanitized HTTP 503 when publication admission is blocked.
- d946542: Make worktree reconciliation, project identity mutations, staged PostgreSQL admission, and cross-project import/export fail closed around one verified project snapshot.
- 9b04984: Retain and revalidate the private events-directory identity throughout sidecar
  health scans and orphan pruning so a replaced parent cannot redirect cleanup.
- 11107b5: Authenticate indirect pg_trgm operator provenance during PostgreSQL readiness.
- a3075ab: Reject project root or `projects` ancestor symlinks during promote metadata
  updates, and retain the authenticated ancestor chain through publication.
- 8d002d7: Authenticate the immediate project metadata parent before promotion reads
  `meta.json`, and retain that identity through bounded reading and atomic
  publication so directory replacement fails closed.
- a9cdaee: Allow secure LCM home admission from Linux user namespaces when a normal host
  context has recorded a matching direct-root parent witness, and bootstrap
  that witness from a constrained namespace through a bounded user-manager
  host-view helper when no witness exists yet.
- bb46089: Reject backend-publication checkpoint writes when the publication directory
  no longer matches the coordinator's retained operation witness.
- 72547c4: Bound fixed SQLite transfer-ledger controls before driver materialization so a
  malformed resume database cannot return an oversized scalar before refusal.
- 130bb7e: Bound explicit native-transcript backfill and embedded API records after
  scrubbing as well as before it. Records whose sanitized canonical UTF-8 form
  exceeds 10 MiB are now quarantined locally as `record-too-large` rather than
  imported; expansive custom patterns may therefore produce new bounded
  quarantine metadata.
- b497571: Reject preliminary project metadata that would exceed 1 MiB after UTF-8
  serialization, preserving any existing metadata instead of publishing a file
  that the next initialization cannot read.
- b1f3d0b: Reject unsafe or oversized project metadata before all-project import, batch
  compaction, and periodic daemon transcript discovery consume its working
  directory.
- 6de16f4: Read `lcm status` project timestamps through bounded, single-link regular-file
  metadata admission, with current-UID ownership checks where numeric UIDs are
  available, while preserving null timestamp fallbacks for unavailable metadata.
- ecbffd3: Bound legacy daemon migration PID and token evidence reads, and refuse FIFOs,
  oversized files, path replacements, and other unsafe leaves without blocking
  restart recovery.
- 186a83d: Redact and bound regex snippets returned by the default SQLite search backend.
- c6bff28: Route Codex process compaction through a single-use loopback Responses gateway
  that replaces inherited prompt and tool state with the LCM summarizer prompt and
  an explicit zero-tools request.
- e4bfa34: Validate `lcm_search` limits at the daemon boundary as positive integers from
  1 through 1000, with a default of 5 and a stable HTTP 400 error for invalid
  values.
- 051c097: Add the staged PostgreSQL conversation, message, and ordered message-part repository with collision-safe session segments, canonical project-scoped advisory locking, atomic contiguous append allocation, nonnegative safe-integer and U+0000-free text inputs, bigint-safe part ordinals, isolation-fenced scoped transactions, serialized scoped operations, and reviewed least-privilege runtime grants.
- 5d1b171: Bound `lcm install` and `lcm doctor` publication-lock admission retries to a
  single authenticated managed daemon and shared timeout, preserving fail-closed
  behavior for foreign or unverifiable owners.
- a47ac73: Release temporary consumer directory descriptors when backend publication
  admission is refused.
- f862b4d: Fail closed when a canonical LCM root is interrupted during authentication
  after its descriptor is opened, while preserving compatibility for roots that
  are absent at the initial read-only probe.
- 3d173aa: Retry authenticated publication contention for local CLI inspection and
  export preparation, while emitting each read result or export exactly once.
  Exhausted or rejected export admission now fails the command, including when
  an all-project export has already written earlier projects.
- a1507a0: Restore actionable guidance when Codex compaction cannot find the Codex CLI,
  while keeping other endpoint-discovery failures generic and secret-free.
- 5ee3383: Keep shared CLI and installer publication-lock retries bounded by monotonic
  elapsed time across wall-clock corrections.
- ee87087: Preserve an owned daemon that may be busy when bounded health checks remain unavailable instead of signaling it and starting a replacement.
- 0cc250b: Make generated Markdown connector installs byte-idempotent, preserving the
  established LF or CRLF style in normal rules append-mode installs and avoiding
  extra blank lines in generated `SKILL.md` files. Rules installs heal recognized
  duplicate current or legacy managed blocks, including the maximal union of
  overlapping or touching recognized ranges, and recover the narrowly recognized
  header-only partial region consisting of a current marker followed only by
  exact `# Workflow Instruction` lines. Arbitrary ambiguous or malformed
  unmatched marker/header combinations remain preserved conservatively and may
  require a second reinstall to become byte-stable; user-authored Markdown,
  including heading lines, outside recognized regions is not removed. Removing a
  rules connector preserves spaces, tabs, form-feed, and other non-CR/LF user
  Markdown bytes with exactly one established terminal EOL, while blank-line-only
  content is deleted.
- cb843bf: Reject non-regular legacy source pattern paths during future worktree
  reconciliations instead of treating them as absent before snapshot, merge, or
  archive verification.
- 192d480: Preserve private-directory authentication failures when descriptor cleanup
  also fails, reporting both errors while keeping the authentication failure as
  the cause.
- 67b8f8d: Preserve structured backend-publication errors when a terminal journal changes
  between initial admission and its archive reread.
- 3bcc75c: Stabilize macOS launchd startup when the GUI domain temporarily retains an absent service label or exposes a transient malformed registration projection after bootstrap. For an exact bootstrap returning numeric code 5 (input/output error), LCM confirms absence before and after each bounded settle and continues only within the same lifecycle deadline, including terminal-job stop/start recovery. Transient malformed metadata is re-observed without mutation during both bounded launchd recovery windows, while persistent malformed state, permission, transport, timeout, ambiguous, registered, other, and deadline-exhausted states remain classified errors.
- ef99469: Keep Codex PostToolUse capture out of legacy-root bootstrap migration so
  concurrent LCM activity cannot fail the observer hook before payload dispatch.
- f0e0c66: Add the staged PostgreSQL lexical-search repository with full-text ranking, database-normalized bounded trigram eligibility, strict runtime limit validation, regex paths, exact project and filter scoping, timeout-safe transaction handling, least-privilege grants, and PostgreSQL 18 conformance evidence.
- fa0bd2a: Document safe initial and incremental native Question issue-type rollouts.
- 86a06c3: Restore deep episodic search recall by giving messages and summaries at least
  50 candidates (and up to the requested maximum) before the final result slice.
  Tag filters now apply only to promoted memories, so tagged searches continue
  to return untagged episodic history. The combined episodic response still fills
  messages first and may reach its maximum before summaries appear.
- 603c95b: Keep worktree reconciliation available when an unrelated stale project-map path crosses a regular file, while preserving strict filesystem validation for the requested project.
- b60b8fd: Recognize Git-compatible inline comments on `extensions.worktreeConfig` when resolving submodule project identity.
- c9991c4: Align the source-clone installer with the packaged `dist/lcm.mjs` CLI
  entrypoint. Existing authenticated daemons started from an older source or
  intermediate entrypoint may require one restart to adopt the canonical runtime
  identity on the next install or use.
- 2bd1328: Capture bounded semantic context from Codex `functions.exec` and
  `functions.exec_command` PostToolUse events, and validate the installed Codex
  hook with structural and no-write functional connector checks.
- eada7df: Reject the misleading `expectedContentSha256` option in the generic durable
  private-file writer and document the portable same-UID replacement boundary.
  Callers that require conditional replacement must use a protocol-specific
  operation with its own recovery grammar.
- c916af6: Classify negative-zero portable manifest record counts as `malformed-manifest`
  before checksum canonicalization while preserving checkpoint and record error
  taxonomy compatibility.
- f571855: Preserve backend publication consumer failures while closing every retained
  directory descriptor and reporting any independent cleanup failures.
- 49957e1: Correct the `lcm-context` skill examples to use the supported repeatable `--tag` option.
- 3c18ddf: Preserve home, migration-entry, and private-file publication failures when
  descriptor or temporary-file cleanup also fails, retaining cleanup errors as
  ordered secondary evidence.
- 15a0d97: Clarify operator recovery guidance for a present backend-publication directory
  without a journal, including the maintainer-assisted support path.
- 38e4106: Add an audience-based documentation index and move the packaged PostgreSQL implementation guides and runtime grant scripts into the storage reference tree.
- 4a54d59: Honor help before required CLI arguments and accept both repeatable store tag spellings.
- b6b1d45: Close atomic exclusive-write temporary descriptors when file or parent identity
  capture fails while preserving ordered cleanup evidence and authenticated-only
  temporary-file removal.
- b5b0a71: Return a closed health status when PostgreSQL factory shutdown races with an
  in-flight runtime health probe.
- cdf9a85: Ensure PostgreSQL project health reports the closed state when project shutdown
  begins, without exposing query details from an in-flight probe.
- a3af066: Classify bounded Codex process failures into safe usage, authentication,
  unavailable-model, and invalid-request guidance while preserving the existing
  compatibility fallback for unknown diagnostics. Usage and authentication
  categories also recognize the loopback Responses gateway's upstream 429 and
  401 statuses without exposing provider response details.
- aca3127: Replace alias-oriented generated agent instructions with seven compact canonical tag conventions and one concrete store example, and clarify that `signal:memory_used` requires a paired `memory_id:<id>` tag for recall usage counting.
- c40d702: Repair `memory.compact` so it sends the project `cwd` required by the daemon,
  while preserving two-argument callers through an invocation-time working
  directory default and supporting explicit project directories.
- 83b835a: `lcm compact` discovery now yields to the event loop between projects,
  conversations, message pages, and source-locator lookups, so the invocation
  lease heartbeat keeps running during a long scan and Ctrl+C or `SIGTERM` stops
  discovery before the next project or conversation instead of after the whole
  scan. An interrupted scan closes the storage it opened, records no failure for
  the interrupted project, and sends no compact request. Requests to the local
  daemon also use a fresh loopback connection each time, so a connection the
  daemon closed at its keep-alive timeout can no longer fail with `write EPIPE`.
- 4d5fedf: Serialize publication admission between operations in the same daemon so
  session completion and promotion can wait for in-flight storage work instead
  of failing with publication contention. Keep project identity checks fenced,
  prevent canceled queued work from opening storage, and retain the native
  hook's existing bounded best-effort completion policy.
- 9ea6006: Use authenticated daemon health when doctor reports storage readiness and distinguish unavailable storage from readiness that could not be verified.
- 75d7af4: Keep doctor publication-convergence retries bounded by monotonic elapsed time
  when the system wall clock jumps forward or backward.
- c483823: Enumerate an unbound PostgreSQL project instead of aborting `--all` discovery.
  
  `lcm compact --all`, `lcm import --all`, `lcm export --all`, and
  `lcm promote --all` call `listCliProjects()` to select every authenticated
  local project. With `storage.backend` set to `postgresql`, a single local
  project that had never been linked with `lcm project create` or
  `lcm project link <project-id>` made `listCliProjects()` reject outright,
  so none of these commands processed any other project either. The unbound
  entry now enumerates under its own local identity, the same way an already
  supported retired-identity fence does, so every other selected project
  still runs. `lcm compact --all` and `lcm export --all` report it as that
  project's own failure and name the `lcm project create` / `lcm project link`
  remedy; `lcm compact --all` previously aborted the whole run with
  `project discovery failed` and compacted nothing. `lcm promote --all`
  reports a generic per-project failure naming the project path, without
  the remedy. `lcm import --all` is session-driven, not project-driven: it
  fails that project's sessions rather than naming the project, and a
  project with no sessions to import produces no failure at all.
  `lcm import --all --dry-run` contacts no project storage, so it does not
  surface this condition at all.
- a2ab334: Expose `lcm_grep` search modes through MCP. Callers can choose `full_text` or
  `regex`; omitting `mode` remains `full_text`, while malformed explicit modes
  (including `null`) are rejected instead of silently defaulting to `full_text`.
- f6927a0: Tighten promotion of passive-learning events when a project working directory
  has disappeared so the flow no longer creates spurious project-map entries for
  never-seen paths, repairs private-directory permissions on existing sidecars,
  and fails closed on malformed or inconsistent persisted parking state during
  both runtime observation and worktree reconciliation.
- eb27833: Restart same-version stale daemons, safely recover the exact empty legacy SQLite instruction cache, and surface per-project compaction scan failures.
- 8c85f1a: Reject unsafe project sensitive-pattern leaves before listing, testing, adding,
  or removing patterns. Project pattern files must now be regular, owned by the
  current user when the platform exposes an effective user ID, and single-link.
- 8b34a28: Reuse validated canonical record bytes to keep maximum-size portable batches
  within the coverage gate while preserving existing portable limits and wire
  semantics.
- a263775: Discard an installer publication-retry identity when the daemon configuration,
  publication journal, or authenticated private LCM root changes during the
  health exchange.
- d21ec1c: Prevent store, ingest, and promote from using project-sensitive scrubber
  patterns when the authenticated project identity changes before storage opens.
  Identity drift now returns the bounded backend-publication blocked response.
- 3cfdfc3: Fence SQLite factory health during shutdown races so in-flight active and idle
  project probes return closed without exposing probe details.
- befd5e4: Fence SQLite project health during shutdown races so in-flight probes return
  closed without exposing probe details.
- 77d637f: Redact hosted `file://` paths when authorities contain supported punctuation
  before the first path separator.
- c14d1fb: Fix two exit classes in the migration cutover. `lcm migration activate` now refuses a fenced-lease row it cannot decode with exit 5 `activation-refused-evidence` (`lease-unresolvable`) instead of an unexpected failure that claims `applied`; a decodable lease held by another publication keeps exit 4. A daemon left running on the previous backend now answers `GET /health/observe` with its identity, so the restart check reports exit 8 (restart required) instead of exit 5 `cutover-restart-contradiction`. A daemon binary from before this change still gives exit 5; run `lcm daemon status`, resolve it, then run `report`.
- fac33df: Allow native Codex MCP connector commands to reach the authenticated current
  user's Linux session bus through an exact, filesystem-validated environment
  pair while continuing to reject unrelated or untrusted inherited values.
- b33c87d: Make `lcm doctor` fail closed on publication contention when the installed
  package version is unavailable or blank.
- 265d59e: Redact paths in malformed bracketed file URLs while preserving valid bracketed
  IPv6 authorities.
- bdb9c2e: Include normal PostgreSQL promotions in knowledge exports and import deduplication, retaining metadata and retry identities across provenance forms. Normalize authenticated local and remote self-provenance during canonical PostgreSQL and SQLite transfers while preserving external origins and SQLite knowledge-export filtering.
  
  Merge exact promoted-memory content independently of the backend search rank, including negative PostgreSQL and SQLite ranks below the fuzzy-match threshold. Nonidentical matches keep the existing threshold (#1153).
- e6167e8: Isolate restored instruction caches by project, machine, client, session, verified worktree, and exact working directory; authenticate linked-worktree metadata bidirectionally and discard unscoped legacy instruction rows during a transactional upgrade.
- 3de5ff7: Reject embedded NUL characters in new SQLite promoted-memory content before
  writing, and fail closed on selected legacy rows instead of returning the
  truncated scalar value. Preserve explicit clean replacements and NUL-bearing
  JSON tags.
- bc501a8: Fail closed when a newly bootstrapped LCM root disappears, is rebound, or
  changes contents during backend publication handoff. The bootstrap retains
  the root descriptor and compares its authenticated pre-handoff tree before
  refreshing the home-parent witness.
- 62dc49a: Keep PreCompact hooks best-effort when PostgreSQL credentials are unavailable, require SQLite health checks to prove rollback-safe writes, and retire pooled handles whose rollback fails.
- ea37ee9: Restrict package-manager bins derived for managed daemon PATHs to recognized
  per-user layouts rooted at an authenticated owner home, while preserving
  legitimate `~/.local` installs and directly observed executable paths.
- dae1629: Update generated gitleaks redaction patterns to 220 rules.
  Correct Slack webhook and Sidekiq URL rules to require literal service
  hostnames instead of treating hostname dots as regular-expression wildcards.
- f699d64: Reject unsupported `lcm export --format` values instead of silently exporting JSON.
- a68dcb2: Honor the `lcm_grep` sessionId filter by selecting the canonical newest
  conversation, rejecting malformed identifiers, and returning an empty result
  for unknown sessions.
- 5c183e9: Validate `lcm_grep` `since` values at the daemon boundary. The inclusive
  lower bound now accepts only full timezone-qualified ISO datetimes with an
  optional 1-3 digit fractional second and returns a stable `invalid since`
  error before project or storage access for malformed values.
- a88419f: Reject grep `since` values whose normalized UTC year falls outside 0001-9999
  before accessing project storage.
- 9648a0f: Reject backend-publication journal changes while the installer verifies that
  its configuration is absent.
- 5922866: Reject changed SQLite database paths before changing their permissions or
  running initialization PRAGMAs, including newly created database files.
- 6bfc7ab: Make the staged PostgreSQL conformance harness validate its complete run identity before database mutation, require every exposed project repository adapter to register a backend-neutral contract suite, raise nested signal-probe readiness from 30 to 90 seconds with the bounded `LCM_TEST_POSTGRES_SIGNAL_READY_TIMEOUT_MS` override, register signal runs before readiness, exhaustively audit every registered run and Docker resource class, converge transient whole-run cleanup failures before signal exit, retain bounded sanitized cleanup diagnostics, remove verified private directories after orphan reclamation, fail signal tests when Docker cleanup does not complete, and tolerate an exactly owned Docker resource disappearing during concurrent orphan recovery.
- 5c7da67: Reject unsafe promote sidecar-root topology instead of creating project
  directories through raw recursive `mkdir`. Dry runs remain free of metadata
  and project-storage writes.
- 8f957c4: Stop treating a daemon whose `/health` omits its storage backend as SQLite unless it is a published release through 1.4.3. A newer daemon that omits the backend is now unknown and is refused for reuse, unauthenticated replacement, and restart.
- 3532a0e: Prevent transient passive reinforcement lookup failures from propagating to
  sibling events while continuing to cache successful values within the batch.
- 9c24fae: Accept Git config files up to 4 MiB during project identity resolution while retaining the stricter 64 KiB limit for Git topology pointers.
- 9174f38: Start passive-event replication automatically on PostgreSQL-backed daemons. A
  PostgreSQL daemon now uploads local hook events to the remote inbox on its own
  passive-event sweep, once at startup and then every five minutes, where before
  that only happened when a worker was run explicitly. Because nothing ran it,
  local events could never reach the acknowledged and remote-pruned state that
  local retention depends on, so a project's event table only grew.
  
  A pass runs for a project only when the backend is PostgreSQL, a machine
  identity is registered, the project is linked to a remote project id, and
  PostgreSQL reports healthy. The first three are quiet skips; an unhealthy
  backend and a machine identity that exists but cannot be read are reported
  instead. A SQLite-backed daemon never opens a PostgreSQL connection, so
  its behaviour is unchanged.
  
  Each sweep phase runs under its own short publication admission, so hook
  appends proceed between phases instead of waiting behind a whole sweep.
  
  `lcm status` now reports what replication has done under `passiveEvents`:
  whether it is enabled, when the last pass ran, and how many events were
  uploaded, applied, acknowledged, pruned, retried and quarantined. `enabled`
  reports backend capability, not progress. `passes` and `lastPassAt` advance on
  every sweep, and `projects` counts passes that returned a result, so an enabled
  daemon with passes and no projects is skipping or failing.
- d2da03c: Keep the configured Codex compaction timeout monotonic across config discovery,
  gateway startup, and execution.
- ad1602d: Keep internal proxy startup health polling on a monotonic elapsed-time
  deadline so wall-clock changes cannot extend or shorten the startup budget.
- 928cd70: Keep native transcript parsing and archival on the same source snapshot, retry one concurrent source change, and drain active ingest work before closing storage on cancellation. Intentional cancellation returns HTTP 499 without recording an ingest error.
  
  Prevent the retry from hiding a source or quarantine cleanup failure; retain both failures and return the existing sanitized ingest failure.
  
  Keep transcript and scrubber preparation outside backend publication admission on every attempt. Drain and close each attempt before retrying, and revalidate publication state and project identity before further writes.
- 9c43b01: Add locally scrubbed, append-only PostgreSQL native transcript ingestion with exact message provenance, resumable checkpoints, metadata-only local quarantine, and least-privilege runtime access.
- 6c293d5: Report a stalled daemon instead of retrying it forever. When the configured
  storage backend is changed while a daemon is already running, that daemon keeps
  the backend it authenticated at startup, so its background passive-event work
  can never be admitted again. It previously retried on its five-minute sweep
  interval indefinitely and only wrote a log line, so a machine could sit with
  passive-event promotion silently stopped. The daemon now stops the sweep after
  the first refusal, reports it once, and exposes a `passiveEvents` object with
  `halted`, `haltedReason`, and `haltedMessage` on the unauthenticated
  `/health` response for as long as the halt lasts. Health is the surface that
  answers here, because every other route is refused under the same mismatch. The
  next hook run still replaces the daemon and clears the halt.
- 888c4e6: Keep proven-unenrolled SQLite projects available when their optional machine
  identity is missing or damaged, while refusing ambiguous receipt-era state.
- 3d30cf0: Allow the exact optional migration receipt v1 epoch/event table pair in captured SQLite sources and resumed portable destinations. Legacy schemas remain supported; partial or malformed pairs still fail closed. Receipt metadata stays private to migration orchestration and is neither authenticated nor copied by canonical transfer.
- 1332a89: Allow worktree reconciliation to preserve an identical passive-event predecessor after that predecessor has been pruned from both local event databases.
- ff9a468: Prevent worktree reconciliation from changing passive-event predecessor identity after delivery may have reached PostgreSQL.
- 4c7ac9b: Pair passive-event scrubber paths with the project identity admitted by the
  selected storage backend. Identity drift now blocks promotion with a sanitized
  503 response before backend open or event acknowledgement, leaving the batch
  pending for a later retry.
- e8b64a0: Patch the bundled URI and query-string parsers against authority confusion, authority injection, and query parsing advisories.
- 4fca1ce: Pin PostgreSQL runtime deparser settings during readiness checks so hostile
  session settings cannot change validated schema fingerprints.
- 920de9b: Pin backend-publication contention retries to the complete authenticated daemon
  identity, including its entrypoint and runtime digest.
- 8016c20: Restructure the GitHub Actions CI pipeline into a plan-driven job graph: pull requests and merge-queue entries run only the test files related to the change, pushes to `main`/`release` run the complete suite sharded across runners with the merged 100% coverage gate, and the PostgreSQL conformance harness runs once on an 8 vCPU runner with CPU-derived workers.
- 7cc1539: Refuse a portable batch successor that duplicates its predecessor's
  identitySha256, matching the official manifest scanner instead of
  letting createPortableBatch admit a stream the scanner would reject
  downstream. Four domains carry an order field outside their logical
  key (passive-events' machineSequence, project-aliases' path,
  summary-message-links' and summary-parent-links' ordinal), so a
  successor could previously repeat a predecessor's identity while its
  order still advanced, which the existing order-regression check does
  not catch. Batches built from any portable record source, including
  the SQLite-to-PostgreSQL migration copy path, now refuse this case
  at construction with a `duplicate-identity` error instead of
  accepting it.
  
  A successor whose order exactly ties its predecessor's (rather than
  advancing past it) now also surfaces `duplicate-identity` instead of
  `order-regression`. Both are non-retryable and belong to the same
  transfer classification, so no caller behavior changes on this exact
  tie case beyond the reported error code.
- f930c8f: Add the transactional PostgreSQL 18 schema, backend-neutral project identity, bounded exact session-ID lookup, complete applied-baseline inventory verification, identity-function drift fingerprinting, scoped privilege hardening, and namespace-aware extension readiness for upcoming PostgreSQL storage adapters.
- 025030b: Add staged PostgreSQL summary-DAG, context-item, and large-file repositories with deterministic traversal, transactional graph integrity, fenced mutation support, least-privilege grants, conformance coverage, and operator diagnostics.
- 491f307: Preserve every recognized nested `file://` scheme while redacting adjacent
  private paths so repeated error sanitization remains stable.
- c0cfd69: Preserve the original directory authentication failure during LCM home
  bootstrap when closing the rejected descriptor also fails.
- d16cdc8: Preserve a validated Codex endpoint when the one-shot app-server settles after
  forced cleanup.
- ef6124d: Preserve a durably completed worktree reconciliation journal when retained
  directory cleanup fails after final validation, while still reporting the
  cleanup error and allowing later discovery of newly eligible work.
- 0435b0b: Preserve nested non-file URLs after an unquoted pathless `file://` query or
  fragment boundary while continuing to redact standalone and nested filesystem
  paths, including query or fragment values quoted around paths containing
  spaces.
- 236a250: Preserve retryable `aborted` errors when a portable source page rejects after
  its read signal is cancelled, without advancing the caller's checkpoint.
- 4af2d79: Preserve scoped machine identity in sanitized PostgreSQL cancellation errors.
- 752cb0e: Carry PostgreSQL coordination and explicitly fenced repository machine identity into sanitized cancellation diagnostics.
- f235833: Preserve project-directory admission and permission failures when closing the
  acquired child handle also fails, while still reporting cleanup failures and
  closing retained ancestor handles.
- beeee0c: Keep completed promotion successful when the best-effort metadata timestamp
  cannot reopen its parent because file descriptors or filesystem space are
  exhausted. Untrusted or invalid parent topology remains a promotion error.
- cd38a66: Authenticate SQLite parent directories before creating, repairing, or pooling
  database connections, and reject unsafe or replaced parents without mutation.
- adf3164: Create missing `import-knowledge` project metadata atomically with owner-only
  permissions while preserving existing metadata and legacy temporary paths.
- d581941: Harden final ingest and compact metadata timestamp updates with bounded,
  single-link reads, owner validation when a process user ID is available, and
  atomic private publication.
- 822e10a: Preserve write/setup failures when temporary descriptor close also fails in
  atomic private-file writers. Retain temporary cleanup errors in ordinary
  replacement and non-durable exclusive creation, and ordered descriptor,
  temporary-file, and parent cleanup errors in durable writes. Existing
  best-effort temporary cleanup in retained-parent exclusive publication and
  `writePrivateFileExclusive` remains unchanged.
- 07115d6: Document the extracted procedural-development and implement-epic skills and the
  revised native Bug triage workflow.
- 3e6a991: Harden automatic promotion metadata updates with bounded reads and atomic
  owner-private publication, including permission tightening for legacy files.
- adb102f: Prevent passive PostgreSQL promotion and portable knowledge import from creating
  duplicate memories when an exact live owner row falls outside the bounded fuzzy
  search page.
- 3eb8f91: Retain backend publication admission through passive sidecar diagnostics,
  resource close, and orphan pruning so concurrent hook appends cannot be deleted
  from a stale snapshot.
- fd05068: Publish the documented canonical transfer API at `@donadiosolutions/lcm/storage/portable`, including TypeScript declarations, record and checkpoint codecs, and SQLite/PostgreSQL adapters. Keep backend publication and coordination internals outside this curated package surface.
- 5ab4b25: Prevent Codex-backed compaction from rejecting otherwise valid user configuration when LCM applies reasoning-effort or fast-mode overrides.
- 544d4f2: Honor Codex's effective OpenAI-compatible endpoint during process compaction
  while preserving managed credential routing and fail-closed lifecycle behavior.
- d0111b2: Limit the managed Codex memory-retrieval rule to substantive work and requests
  for further project understanding so passive hook injection does not trigger a
  redundant explicit memory search.
- 9e7f8b7: Reject unsupported `lcm connectors list --format` values before connector inventory work.
- 388490f: Bound doctor health checks and recover the managed daemon once when automatic post-compaction promotion loses its transport.
- b5c74b9: Preserve existing SQLite sidecars when status, pool statistics, and doctor authenticate an already-running daemon. These diagnostics now observe process identity without invoking active storage readiness. Doctor reports that readiness and passive queue draining remain unverified, separately from its backend read diagnostics.
- 7ef5802: Keep healthy-daemon memory and status reads available while publication holds
  the exclusive lock, buffer and revalidate each result across publication
  changes, and recognize the Codex 0.147.0 prefixed MCP absence diagnostic
  without weakening fail-closed connector verification.
- 1148805: Allow aggregate SQLite diagnostics to omit admitted project directories whose
  databases have not been initialized while preserving fail-closed selected and
  topology-changing observations.
- f6927a0: Persist missing-working-directory confirmation and reversible local-promotion parking in each existing passive-learning sidecar. Three observations at least five minutes apart now survive daemon restarts and sparse sweep rotations without a fixed expiry. Parking no longer advances event `processed_at`: unprocessed events, history, and delivery state remain intact, repeated absent sweeps return a quiet terminal state, and a later cwd recovery clears the state and promotes the preserved backlog normally.
- edb38bd: Redact doubled-colon drive segments inside recognized local paths so malformed
  Windows path tails cannot remain visible in sanitized errors.
- 73bbd65: Prevent bounded reads from blocking on special files such as FIFOs.
- 3fd4957: Stop counting successful Codex PostToolUse capture as a hook error when backend
  publication metadata reconciliation contends after the event is durably queued.
- 8114f15: Add the internal verified-TLS PostgreSQL 18 pool and migration foundation plus a digest-pinned, run-isolated conformance harness for upcoming PostgreSQL storage adapters.
- 82f0409: Let `lcm doctor` and connector transport resolution converge through a managed
  daemon's short backend-publication reconciliation immediately after
  `lcm install`. Configuration reads use authenticated, descriptor-bound
  lock-free snapshots while retaining and revalidating the canonical private LCM
  root when one is present. Legacy SQLite reads without an admissible root remain
  compatible only while publication evidence is absent. The lock-taking doctor
  stages (project map, worktree reconciliation, daemon lifecycle) retry within
  one shared two-second budget only while the lock owner is the exact
  token-authenticated managed daemon. Platform process-birth helpers and health
  probes are bounded by that remaining shared budget. All configuration and
  project-map mutations still require the exclusive publication lock, and any
  other owner remains fail closed.
- c7a1e4d: Redact private path continuations around nested public URLs in one stable
  sanitization pass while preserving the public URL bytes.
- e89b1e8: Authenticate private project database topology before `lcm stats` opens or
  migrates existing SQLite state, and never create a missing project database.
- e962f17: Interpret timezone-less SQLite timestamps as UTC across conversation reads,
  promoted-memory age calculations, and summary metadata migrations.
- b1fc61f: Wait up to one second for Claude session-completion acknowledgment before the hook exits, so a promptly responding daemon can persist the completion record. Completion remains best-effort on admission or transport failure; a timeout may occur after persistence. Codex turn behavior and background compaction/promotion remain unchanged.
  
  Read authenticated hook settings before ingestion to avoid dropping completion when a post-ingest configuration reload contends with daemon writes. Settings remain consistent throughout the invocation; configuration admission failures now prevent ingestion before any transcript is stored.
- 30b4121: Validate the daemon `POST /recent` limit as an integer from 1 through 1000,
  defaulting omitted limits to 5 and rejecting malformed values before project
  or storage admission.
- a4be2e7: Reconcile verified legacy Git worktree identity before Codex import and remote
  passive-event operator admission so existing PostgreSQL bindings are retained.
- 4fcbd65: Refuse legacy conversation message content with embedded NUL bytes or a
  non-TEXT SQLite type during worktree reconciliation, preserving source and
  target data for repair and retry.
- c52888b: Allow an explicit daemon restart to recover an exact managed service that owns backend publication but produces no HTTP response, while preserving fail-closed config, journal, process, and manager identity checks.
- 2f1b087: Redact drive-shaped path continuations after earlier content in bracketed
  file URL query and fragment values.
- cfff837: Redact local paths after embedded double quotes in exact `file://` authorities
  while preserving matching outer quote boundaries.
- 976ea47: Redact root-relative Windows paths handed off from bracketed file URL query and
  fragment values after punctuation, horizontal spacing, or nested URL content,
  including IPv6 URLs with a following path, port, or query.
- a50fdb5: Redact paths in hosted file URLs from sanitized error messages while preserving
  the URL scheme and authority.
- 88bbcbd: Prevent MCP error diagnostics from exposing suffixes of brace-delimited credentials.
- b18d02f: Redact local paths inside or after bracketed query and fragment values on
  pathless file URLs.
- 02281cc: Redact an adjacent path segment after a closing malformed file URL bracket in
  the same sanitizer pass.
- 3c4894e: Prevent connector removal and install rollback from deleting or overwriting a
  replacement at an authenticated connector pathname. Linux connector mutations
  now stage complete candidates privately, claim existing leaves by atomic rename,
  and publish with no-replace hard links. Wholly managed leaves are physically
  removed after validation; concurrent replacements remain intact and named
  recovery artifacts are reported when compensation cannot restore the receipt.
  
  Bind connector publication and rollback authority to immutable pre-link
  certificates (SHA-256, size, full mode, and canonical device/inode identity),
  so post-link edits to either alias cannot be adopted as LCM state. Certified
  restore candidates preserve logical initial bytes and mode on a new inode;
  external hard links remain attached to the old inode. Evidence and named
  recovery artifacts are retained when a claim, compensation, or finalization
  cannot be validated.
  
  Sanitize connector removal and rollback diagnostics so retained descriptor
  operation paths and nested low-level error causes are never exposed publicly.
  Refuse connector leaves and snapshots larger than 4 MiB before read allocation
  or mutation.
- 07396fd: Refuse promotion metadata publication when a restored or concurrent `meta.json`
  appears after a missing-file observation, preserving the existing file instead
  of replacing it. Report post-link cleanup or single-link verification failures
  as critical published outcomes so an ambiguous `meta.json` cannot be hidden by
  best-effort metadata handling.
- ce21f6e: Refuse SQLite migration snapshots and queue evidence when the platform cannot
  authenticate UID or retained descriptor traversal.
- 2fcc0b5: Reject negative-zero portable checkpoint counts as `checkpoint-mismatch`
  before checksum canonicalization across direct and canonical wire APIs.
- 083fd25: Anchor connector parent traversal through retained Linux proc descriptors so
  intermediate symlinks cannot redirect project or home writes. Filesystem-backed
  connector install/remove now refuse on unsupported platforms or without the
  required proc/flag guarantees, and the default pathname-based native Codex MCP
  add/remove path emits manual guidance instead of mutating automatically.
- 0bc28df: Make daemon startup recovery retire authenticated terminal systemd registrations, including stale failed units, before proving absence and recreating the managed service. This completes the #663/#665 daemon startup-recovery lifecycle hardening.
- 456e917: Passive-event replication no longer leaves rows stuck after a project is
  relinked to another remote project: rows still awaiting the previous project
  are withdrawn from it (or acknowledged, or kept quarantined, depending on
  what that project did with them) and uploaded to the new one. The replication
  pass also opens the scanned sidecar before resolving the project's identity,
  so a missing sidecar no longer creates or publishes project-map evidence.
- b962d58: Diagnose retired local project identity fences in prompt hooks and batch
  compaction, and report that diagnosis for every storage backend rather than
  only SQLite. Add an idempotent identity-renewal command that resolves the Git
  project anchor first, so it can be run from a nested directory or a linked
  worktree as its own diagnostic advises. Renewed projects keep working after
  renewal: worktree reconciliation treats an authenticated successor as the
  target instead of folding it back into the retired hash, and identity evidence
  authenticates a successor id against the retained predecessor fence so a
  renewed project can still recover its sidecar when the map is unavailable.
  Reconciliation authenticates renewed bindings reached through distinct local
  aliases, preserves valid aliases on the successor, and refuses ambiguous or
  foreign canonical bindings before source discovery.
  After successor map publication becomes observable or its outcome is unknown,
  it remains authoritative through later validation or readback failures so
  concurrent hook storage cannot be stranded behind a restored retired binding.
  Preserve bounded per-item identity and outcomes throughout compact progress and
  summaries, keeping invocation-wide failure totals in the live header, the
  failure event, and the final summary instead of repeating them on later
  per-item lines.
- ddffca8: Remove newly created daemon temporary directories whose owner permissions were
  clipped by the process umask, and report an actionable retry requirement while
  preserving fail-closed validation for existing paths.
- fcc91bc: Repair Codex process compaction with `gpt-5.3-codex-spark` by using the
  supported standard Responses shape, accepting its optional stream terminator,
  and reporting upstream request failures without misleading CLI upgrade advice.
- a1c9e5e: Require an exact local runtime digest before doctor retries daemon-owned publication contention.
- ddb450f: Restore a minimal managed `~/.codex/AGENTS.md` memory-retrieval rule to the
  default Codex CLI connector bundle while preserving the detailed `lcm-memory`
  skill and native hooks. Existing user rules remain intact, explicit Codex MCP
  bundles omit the CLI-only entry, and reinstalling remains byte-idempotent.
- a9b91f3: Retain the authenticated backend-publication history directory through terminal
  archive creation, exact replay, and durability flushes so path replacement is
  refused without advancing the next publication.
- 4e0ca7a: Reuse retained consumer publication admission while recording missing-working-
  directory observations, closing the local outbox, and persisting error-to-fix
  correlation. Parking can now reach its third durable observation and correlated
  pairs complete local acknowledgement on their first promotion pass without
  self-contention.
- 190e3f9: Redact private paths after ambiguous apostrophes in single-quoted `file://`
  authorities, including separately quoted nested file URLs whose paths contain
  spaces. Close quoted file paths inside brackets so later standalone paths are
  also redacted on the first pass, including backslash paths immediately after
  the closing quote in an unmatched bracket or after a root-only quoted path.
  Redact backslash paths in an exact file URL's own query or fragment while that
  file-URL context remains active.
- 71c32db: Retain publication admission while SessionStart prunes the local passive-event
  outbox, preventing backend publication from racing destructive maintenance.
- 4e8b2fd: Retain the authenticated reconciliation journal directory throughout each
  locked mutation attempt so normal and blocked-state journal writes detect a
  replaced parent and fail closed. Refuse lock-contention retries when that
  authenticated directory changed during the attempt.
- 265b46a: Retry daemon storage-factory cleanup once in the same terminal pass after a
  rejected close while preserving concurrent close coalescing and
  successful-close idempotence.
- 7eb216a: Require local evidence before a project-map key becomes a storage identity,
  and stop presenting identities that storage will refuse.
  
  A key is now admitted only when it is the canonical path hash, a renewal
  successor whose retained predecessor fence still authenticates it, or a legacy
  hash corroborated by its own project metadata. A key meeting none of these is
  refused instead of silently becoming the project id for a directory.
  
  Renewal successors are decided by their predecessor fence alone, so the
  metadata a renewed project writes when storage first opens it cannot stand in
  for a fence that has been lost.
  
  Surfaces that act on a project follow the same rules. `lcm compact --all` and
  SQLite compaction preview skip an identity they cannot authenticate and
  continue with the remaining projects, and adding an alias to one is refused
  before the map is written. `lcm project list` and `lcm project show` mark
  such an entry as unauthenticated rather than hiding it, so it stays visible
  for repair.
- bc8c4ad: Redact private paths that error sanitization previously left visible after a
  nested public URL. A rooted successor is now redacted when the nested URL
  carries brackets, such as an IPv6 authority or a bracketed path segment, and a
  Windows drive root now arms the same handoff as a slash or backslash root.
  Bound terminal fields also count supplementary CJK ideographs as two columns so
  live-frame output keeps its promised width.
- 3475f46: Report unbound and unopenable projects honestly across CLI enumeration surfaces.
  
  `lcm --help` now lists `project renew-retired-identity` in the top-level Runtime summary, matching the detailed `lcm project --help` grammar.
  
  `lcm promote --all` and `lcm import --all` name the static `lcm project create` / `lcm project link <project-id>` remedy for an unbound PostgreSQL project instead of a generic per-project failure; other per-project failures keep their generic text. `lcm export --all` names the affected project path on every failure line, and its final summary reports how many projects could not be exported alongside the entries exported.
  
  Hook-durability identities (`localProjectIdentity`) no longer satisfy call sites that require a PostgreSQL remote binding at compile time; such call sites resolve loudly through a dedicated helper instead of degrading into a permanent unbound refusal.
  
  When enumeration succeeds but every selected project fails to open, `lcm compact --all` reports how many selected projects failed instead of claiming project discovery failed.
- c30ae80: Distinguish backend-publication absence from unresolvable reads. The
  PostgreSQL publication witness now returns a discriminated absent, mismatch,
  or unresolvable outcome instead of throwing one undifferentiated failure, and
  the publication guard reserves invalid-row for genuinely undecodable rows
  while a decodable non-matching row reports fence-mismatch. Synchronous-origin
  lock tokens are refused at asynchronous coordinator seams.
- c2a6d71: Preserve Codex PostToolUse events across typed publication-lock contention and
  surface fail-closed publication admission failures through a fixed,
  credential-free diagnostic and protocol-safe `systemMessage` with documented
  recovery guidance.
- d68cd4a: Publish foreground and detached daemon PID files through private atomic
  replacement. Existing symlink and hardlink targets remain unchanged, the
  published PID file is mode `0600`, and its state directory is tightened to
  mode `0700`; startup reports a failure when secure publication cannot finish.
  Publication failure does not use unpublished PID state to signal a process
  that may already have bound or spawned.
- fbea2ff: Migrate authenticated legacy Linux daemons only after their PID file disappears during exact stop, bind bounded systemd stop/final polling to the exact authenticated invocation ID until unit absence, and refuse every discoverable unit that is not fully authenticated running or PID evidence whose descriptor cannot be closed safely.
- 2ecc6b4: Make the PostgreSQL development harness recover proven stale Docker resources safely and clean up local test consumers reliably after process termination.
- 9ee092d: Reject accessor-backed and symbol-bearing promoted metadata arrays before reading their values.
- 6e852d9: Redact file URL authority and path tails glued to an already active unquoted
  absolute path, including userinfo, ports, and bracketed hosts. This keeps
  public error responses stable after one sanitization pass without changing
  standalone URL classification.
- 1f11c69: Fix error-message path sanitation across quoted URL, drive, nested-bracket,
  IPv6-fragment, and scheme-shaped path handoffs. Private path spans are now
  removed in the first pass while separate public URLs remain unchanged.
- b37a2bd: Harden describe and expand compatibility handlers by sanitizing fallback error
  messages before response serialization, without changing their external HTTP
  status or response shape.
- 89c83fb: Keep public daemon health storage-free and path-free while retaining authenticated health diagnostics for lifecycle checks, clients, and doctor.
- 1e5ebcd: Require authenticated Git metadata backlinks and contained common directories while parsing bounded worktree configuration without backtracking.
- 2dbd5a9: Bind each reconciliation lock and journal callback to one directory identity,
  preserve unsafe or substituted journals during reads, listing, and recovery
  writes, and create missing journals exclusively.
- 0d5f4a5: Reject foreign-owner or multiply linked project metadata before using it to
  restore missing project-map entries.
- 31a61a2: Reject multiply linked or owner-mismatched project metadata before project
  admission can parse or rewrite it, while preserving early metadata creation and
  malformed snapshot recovery.
- b34389f: Reject empty, removed, or rebound backend-publication evidence directories
  instead of treating them as legacy SQLite installations without publication
  evidence.
- e0d443e: Reject wrong-owner or hard-linked reconciliation patterns and reject journals
  that are wrong-owner, hard-linked, or not owner-only before trusting their
  contents.
- ff568a0: Reject untrusted ownership and hard links on canonical reconciliation metadata
  before parsing or reusing its content.
- dab7f57: Update the bundled URI parser to a patched release that prevents backslash authority host confusion while preserving the deduplicated MCP SDK and AJV build graph.
- 46c5955: Clean up Codex configuration resolver witnesses after proven failure, abort,
  and timeout settlement while retaining unproven witnesses for reconciliation.
- bcc9bab: Skip portable source page reads for authenticated authoritative-empty domains
  and return their canonical empty terminal batches.
- ac0565d: Seal private SQLite snapshot artifacts to read-only mode before the final file
  sync, so that sync includes the final permission metadata before the committed
  snapshot marker is published.
- feb2ef2: Make bracketed slash-prefixed URL-shaped paths converge to one redacted marker
  on the first error-sanitization pass while preserving ordinary nested URLs and
  independent filesystem-path redaction.
- e3ed05a: Keep healthy managed daemons admissible when callers differ only in shell locale or time-zone presentation settings.
- 10f545c: Keep default managed daemon start, doctor, and restart calls on one packaged runtime identity, and wait through an exact bounded systemd stop transition before recreating the service.
- 33fe5d5: Managed background daemons now use a stable, private state-root temporary
  directory independent of the caller's `TMPDIR`, `TMP`, and `TEMP` values.
- e7baaba: Correct `lcm stats` compression output to compare compacted conversations with the total conversation count.
- 8dce7d9: Document the crash-recoverable backend-publication admission boundary, secure
  local state-root establishment, staged PostgreSQL privilege posture, and
  fail-closed operator behavior.
- aedab5f: Retry short authenticated root-bootstrap contention during a bounded window across CLI startup—20 total attempts at 50 ms intervals, up to about 950 ms—so read-only commands such as `lcm search` continue after a competing bootstrap completes, while ambiguous or unsafe lock states still fail closed.
- ca4502e: Run source and packaged SQLite diagnostic workers with explicit Node
  type-stripping and SQLite flags, retain authenticated SQLite pool
  counts across bounded collection timeouts, and preserve known backend identity
  when daemon statistics routes sanitize unexpected failures.
- 247c55e: Repair an authenticated managed daemon with stale service configuration during `lcm doctor` while preserving fail-closed lifecycle refusals and reporting the repaired restart.
- cb9a7cb: Redact slash-prefixed local paths after word-bearing query or fragment text
  following a quoted `file://` path in one sanitization pass, keeping repeated
  sanitization byte-stable.
- df2bb7d: Allow trusted immutable-release recovery to authenticate a manually published
  release when an exact failed draft workflow for the same signed tag and commit
  completed before publication, while preserving all tag, ancestry, history,
  artifact, and npm ordering checks.
- 4ccf628: Harden release publication against local tarball path ambiguity and delayed npm registry propagation.
- 821f2f4: Wait through authenticated backend-publication sweep contention at explicit daemon restart boundaries without replaying the restart or weakening PID, token, process-birth, manager, and runtime identity checks. Preserve the original typed contention when bounded admission cannot converge, while reporting an ordinary later publication failure unchanged.
- 35d21a8: Complete legacy-home admission before `lcm store`, then reuse an authenticated
  healthy daemon without redundant lifecycle discovery while preserving the
  locked fallback and daemon-side mutation admission.
- b7cdaf8: Reject portable manifests that mark a domain authoritative-empty while claiming a nonzero record count or a prefix digest other than the seeded empty-domain digest.
- 0aea3d3: Honor Git's final `extensions.worktreeConfig` assignment and keep exact retired event fences out of sidecar health scans while surfacing malformed candidates.
- caa0ed2: Keep MCP SDK build dependencies out of published consumer dependency paths, install and verify native Claude settings before removing Marketplace plugins, normalize legacy HTTP/SSE entries to stdio while preserving compatible options, and preview native settings changes without mutating them during dry-run.
- 040f736: Surface typed PostgreSQL surfacing-log failures from `/prompt-search` as
  sanitized HTTP 503 responses without falling back to SQLite, while keeping the
  prompt hook's optional hint behavior fail-open.
- 73a82cd: Replace polling external admission with event-driven evaluation and add a default-branch `repository_dispatch` recovery path for exact commit SHAs.
- 995a054: Resume ordinary local outbox upgrades and backend publication after migration
  maintenance is aborted or target selection completes. Preserve terminal journal
  evidence for retry when observation or replacement fails.
- 3744da4: Keep session-end background scheduling failures independent so ordinary publication contention does not prevent later promotion requests or Claude session completion. Preserve fail-closed handling of local publication-journal errors.
- 9d3b54d: Keep valid Claude transcript text when malformed sibling blocks are present.
- 5dd1a3f: Fix PostgreSQL daemon startup in the installed CLI by resolving SQL assets from their packaged location. Missing or modified migration files continue to fail verification without falling back to source files or SQLite.
- ce6f56a: Restore 7-day local event retention on SQLite installs. SessionStart prunes
  processed passive-learning events older than seven days, but since the durable
  PostgreSQL replication work landed, that prune also required each row to have
  been acknowledged and pruned by a remote inbox. A SQLite-backed install has no
  remote inbox and the schema cannot mark such a row acknowledged, so the prune
  deleted nothing at all and the local events table grew without bound.
  Retention now waits for remote proof only where PostgreSQL replication can
  actually claim the rows. An event that never entered the remote pipeline is
  reclaimed on age again, while any event still carrying remote state keeps the
  full drained proof, so nothing is destroyed before replication has it.
  
  Upgrading a SQLite install reclaims the backlog on the first SessionStart:
  processed events older than seven days that were never claimed for remote
  delivery are deleted, including everything accumulated since the replication
  gate made the prune a no-op (2026-07-30). That prune runs under the hook
  publication fence, so a large backlog also lengthens that hold on the
  first start after upgrading.
- 3206568: Fix SQLite health checks incorrectly reporting unavailable after multiple projects are opened in the same home. Factory health probes now run sequentially per home, including overlapping health requests, while preserving maintenance and real contention checks.
- a909b21: Harden PostgreSQL test-process and orphan-resource teardown, and clean isolated Vitest homes at the end of each run.
- cc1ad85: Bind external admission to authenticated exact-head CI and DCO evidence, including the canonical pull-request CI run, before accepting a pull request.
- dbbd850: Prevent private mutation-lock ownership checks from executing process-birth helpers found through an untrusted `PATH` or working directory.
- e5c524c: Validate release markers and publication history with trusted default-branch policy before tagged package code is available.
- fd643dd: Report bounded upstream Responses stream failures with retry guidance instead
  of suggesting a Codex CLI upgrade.
- 6106047: Interpret timezone-less SQLite message timestamps as UTC across message reads
  and message search results, preserving millisecond precision and qualified ISO
  instants. Newly generated compaction summaries use the corrected message
  instants at creation. The separate SQLite metadata backfill issue #1092 can
  still rewrite summary bounds when the database is reopened.
- 3e5556c: Validate fenced PostgreSQL summary, context, and large-file repository machine
  identities as canonical UUIDv7 values. Case-insensitive inputs are normalized
  to lowercase, while invalid identities fail synchronously without exposing the
  supplied value in diagnostics.
- 1fae45b: Reject unknown portable domains and invalid read limits before a portable
  source adapter authenticates or reads the requested page.
- 563d64d: Keep managed daemon validation working inside Linux `PrivateTmp` user
  namespaces by matching the loopback listener's kernel cgroup to the exact
  systemd service while preserving fail-closed PID, health, and manager identity
  checks.
- 0103c51: Use integrity-verified pnpm for source installation, development, and release builds. Source installs use the frozen lockfile, and source pattern-regeneration guidance uses the shared development script. Published npm installation and the Node runtime remain unchanged.
- fc852b6: Require compact drain recovery to verify that a replacement daemon has the
  same packaged runtime digest as the invoking CLI.
