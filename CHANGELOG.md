# @donadiosolutions/lcm

## 2.0.0

### Major Changes

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
- 92dc218: Update the optional OpenAI peer dependency to OpenAI SDK 7.3.0 and require
  Node.js 22.12.0 or newer.
- ff25c98: Make stats, status, pool diagnostics, local MCP statistics, and doctor report a shared sanitized snapshot for the selected SQLite or PostgreSQL backend, with bounded collection and explicit readiness/failure states. Omit unavailable metrics and content-bearing previews instead of exposing private data or reporting false zero totals.

  Make doctor observational throughout: it no longer starts or restarts the daemon, repairs settings or project maps, prunes orphan sidecars, or spawns an MCP server for a handshake. Use the reported explicit installation, connector, or daemon restart commands for repairs. SQLite diagnostics read committed WAL data without schema migration or durable content changes; necessary WAL/SHM read coordination may still occur.

  Show the same complete, safe readiness fields and fixed next actions across diagnostic text output, including failure snapshots. Distinguish aggregate and selected project scope with admitted UUIDs/local hashes, keep unknown selections unavailable, and report absent SQLite machine identity as not applicable without requiring registration.

  Reuse one bounded SQLite diagnostic child across projects and sidecars, preserving the whole-snapshot deadline. Keep an authenticated daemon reported as up when its status request fails, and identify the subsequent local diagnostic observation.

  Preserve independently observed daemon pool counts and the failure latch when the remote diagnostic probe times out or fails, after reauthenticating publication and configuration. Keep the backend failure classification and recovery action distinct from pool-count availability.

### Minor Changes

- 29c8179: Add a curated `@donadiosolutions/lcm/storage/postgresql` production factory for explicit programmatic callers, with eager PostgreSQL 18 schema, exact extension ownership, hardened least-privilege readiness, publication-admitted cross-machine project identity, and deterministic lifecycle handling.
- 631481b: Extend automated issue triage to identify, link, and close high-confidence duplicate bug reports.
- 2f4e59f: Support Changesets beta releases with Codex-generated, pull-request-linked draft GitHub notes and publish npm only after a maintainer publishes the draft.
- e5bcefc: Add bounded manual compaction concurrency with replay ordering, dry-run
  validation, invocation leases, and drain-safe cancellation diagnostics.
- 9b3f706: Add durable, versioned local passive-event envelopes; staged PostgreSQL inbox delivery, fenced completion, retry, quarantine, exact replay, and crash-safe acknowledgement/pruning; and operator status, validation, quarantine-inspection, and replay commands while keeping hooks fully local and offline.
- 5797f91: Add the checksum-sealed reversible-migration manifest, legal transition protocol, and crash-recoverable private revision journal used by SQLite/PostgreSQL cutover workflows.
- 842104b: Launch managed systemd and launchd daemons through a bounded clean environment so ambient manager variables cannot override staged credentials. Consume authenticated launchd credential files once and retain their immutable in-memory startup snapshot for in-process configuration reloads.
- 90a10e4: Manage daemon recovery through the current user's systemd or launchd service
  manager, recreate normally idle services on demand, preserve the tri-state
  no-response boundary, and provide canonical doctor, restart, and connector
  repair guidance instead of offline process recovery.

  Foreground or detached compatibility daemons are not eligible for automatic offline force recovery: if they stop returning HTTP responses, `lcm daemon restart` refuses and gives operator/manual recovery guidance instead of signaling or replacing the process.

- 8cd22b8: Publish the versioned backend-neutral portable record stream compatibility
  contract and its operator/adapter documentation as groundwork for later
  import/export and migration workflows. This does not activate CLI, cutover, or
  runtime backend routing.
- 6fac804: Activate verified PostgreSQL project-storage routing for the daemon and MCP
  paths, including bounded cancellation, shutdown cleanup, and fail-closed
  identity and backend errors.
- 87d5179: Add secure SQLite/PostgreSQL backend selection and PostgreSQL connection configuration, while retaining SQLite as the zero-configuration default.
- da03d2d: Add staged PostgreSQL promoted-memory, recall, redaction-administration, and session-coordination repositories with SQLite metadata parity, atomic scoped purge, least-privilege grants, and shared conformance coverage.
- e2b4b63: Add staged PostgreSQL cross-machine transaction locks, fenced leases, final-write validation, fair passive-inbox claims, bounded cleanup, diagnostics, and least-privilege runtime grants.
- 5ab4b25: Unify linked Git worktrees under one local project, transactionally preserve and merge legacy worktree memory, and conservatively reconcile Codex transcripts from deleted managed worktrees.

### Patch Changes

- d08d3b6: Preserve fixed owner-preserving umask guidance when daemon start, restart, or a
  shared CLI consumer reports the matching managed lifecycle refusal.
- bce07ed: Refuse private metadata publication earlier when a retained parent or temporary
  file changes, and report whether a rename completed or its publication outcome
  is unknown when topology changes after the rename attempt.
- 8c2bdd5: Keep the process-local worktree discovery cache on a monotonic elapsed-time
  clock so wall-clock corrections cannot extend or shorten its 1,000 millisecond
  TTL.
- a6c57d2: Preserve retained project and event topology diagnostics when reconciliation
  fails after a target database commit, while retaining rollback failures as
  secondary error evidence.
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
- 130bb7e: Bound explicit native-transcript backfill and embedded API records after
  scrubbing as well as before it. Records whose sanitized canonical UTF-8 form
  exceeds 10 MiB are now quarantined locally as `record-too-large` rather than
  imported; expansive custom patterns may therefore produce new bounded
  quarantine metadata.
- b497571: Reject preliminary project metadata that would exceed 1 MiB after UTF-8
  serialization, preserving any existing metadata instead of publishing a file
  that the next initialization cannot read.
- 6de16f4: Read `lcm status` project timestamps through bounded, single-link regular-file
  metadata admission, with current-UID ownership checks where numeric UIDs are
  available, while preserving null timestamp fallbacks for unavailable metadata.
- ecbffd3: Bound legacy daemon migration PID and token evidence reads, and refuse FIFOs,
  oversized files, path replacements, and other unsafe leaves without blocking
  restart recovery.
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
- 192d480: Preserve private-directory authentication failures when descriptor cleanup
  also fails, reporting both errors while keeping the authentication failure as
  the cause.
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
- 9ea6006: Use authenticated daemon health when doctor reports storage readiness and distinguish unavailable storage from readiness that could not be verified.
- 75d7af4: Keep doctor publication-convergence retries bounded by monotonic elapsed time
  when the system wall clock jumps forward or backward.
- a2ab334: Expose `lcm_grep` search modes through MCP. Callers can choose `full_text` or
  `regex`; omitting `mode` remains `full_text`, while malformed explicit modes
  (including `null`) are rejected instead of silently defaulting to `full_text`.
- f6927a0: Tighten promotion of passive-learning events when a project working directory
  has disappeared so the flow no longer creates spurious project-map entries for
  never-seen paths, repairs private-directory permissions on existing sidecars,
  and fails closed on malformed or inconsistent persisted parking state during
  both runtime observation and worktree reconciliation.
- eb27833: Restart same-version stale daemons, safely recover the exact empty legacy SQLite instruction cache, and surface per-project compaction scan failures.
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
- fac33df: Allow native Codex MCP connector commands to reach the authenticated current
  user's Linux session bus through an exact, filesystem-validated environment
  pair while continuing to reject unrelated or untrusted inherited values.
- b33c87d: Make `lcm doctor` fail closed on publication contention when the installed
  package version is unavailable or blank.
- 265d59e: Redact paths in malformed bracketed file URLs while preserving valid bracketed
  IPv6 authorities.
- e6167e8: Isolate restored instruction caches by project, machine, client, session, verified worktree, and exact working directory; authenticate linked-worktree metadata bidirectionally and discard unscoped legacy instruction rows during a transactional upgrade.
- bc501a8: Fail closed when a newly bootstrapped LCM root disappears, is rebound, or
  changes contents during backend publication handoff. The bootstrap retains
  the root descriptor and compares its authenticated pre-handoff tree before
  refreshing the home-parent witness.
- 62dc49a: Keep PreCompact hooks best-effort when PostgreSQL credentials are unavailable, require SQLite health checks to prove rollback-safe writes, and retire pooled handles whose rollback fails.
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
- 3532a0e: Prevent transient passive reinforcement lookup failures from propagating to
  sibling events while continuing to cache successful values within the batch.
- 9c24fae: Accept Git config files up to 4 MiB during project identity resolution while retaining the stricter 64 KiB limit for Git topology pointers.
- d2da03c: Keep the configured Codex compaction timeout monotonic across config discovery,
  gateway startup, and execution.
- ad1602d: Keep internal proxy startup health polling on a monotonic elapsed-time
  deadline so wall-clock changes cannot extend or shorten the startup budget.
- 9c43b01: Add locally scrubbed, append-only PostgreSQL native transcript ingestion with exact message provenance, resumable checkpoints, metadata-only local quarantine, and least-privilege runtime access.
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
- 07115d6: Document the extracted procedural-development and implement-epic skills and the
  revised native Bug triage workflow.
- 3e6a991: Harden automatic promotion metadata updates with bounded reads and atomic
  owner-private publication, including permission tightening for legacy files.
- 5ab4b25: Prevent Codex-backed compaction from rejecting otherwise valid user configuration when LCM applies reasoning-effort or fast-mode overrides.
- 544d4f2: Honor Codex's effective OpenAI-compatible endpoint during process compaction
  while preserving managed credential routing and fail-closed lifecycle behavior.
- d0111b2: Limit the managed Codex memory-retrieval rule to substantive work and requests
  for further project understanding so passive hook injection does not trigger a
  redundant explicit memory search.
- 9e7f8b7: Reject unsupported `lcm connectors list --format` values before connector inventory work.
- 388490f: Bound doctor health checks and recover the managed daemon once when automatic post-compaction promotion loses its transport.
- 7ef5802: Keep healthy-daemon memory and status reads available while publication holds
  the exclusive lock, buffer and revalidate each result across publication
  changes, and recognize the Codex 0.147.0 prefixed MCP absence diagnostic
  without weakening fail-closed connector verification.
- f6927a0: Persist missing-working-directory confirmation and reversible local-promotion parking in each existing passive-learning sidecar. Three observations at least five minutes apart now survive daemon restarts and sparse sweep rotations without a fixed expiry. Parking no longer advances event `processed_at`: unprocessed events, history, and delivery state remain intact, repeated absent sweeps return a quiet terminal state, and a later cwd recovery clears the state and promotes the preserved backlog normally.
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
- e89b1e8: Authenticate private project database topology before `lcm stats` opens or
  migrates existing SQLite state, and never create a missing project database.
- 30b4121: Validate the daemon `POST /recent` limit as an integer from 1 through 1000,
  defaulting omitted limits to 5 and rejecting malformed values before project
  or storage admission.
- a4be2e7: Reconcile verified legacy Git worktree identity before Codex import and remote
  passive-event operator admission so existing PostgreSQL bindings are retained.
- cfff837: Redact local paths after embedded double quotes in exact `file://` authorities
  while preserving matching outer quote boundaries.
- a50fdb5: Redact paths in hosted file URLs from sanitized error messages while preserving
  the URL scheme and authority.
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
- 2fcc0b5: Reject negative-zero portable checkpoint counts as `checkpoint-mismatch`
  before checksum canonicalization across direct and canonical wire APIs.
- 083fd25: Anchor connector parent traversal through retained Linux proc descriptors so
  intermediate symlinks cannot redirect project or home writes. Filesystem-backed
  connector install/remove now refuse on unsupported platforms or without the
  required proc/flag guarantees, and the default pathname-based native Codex MCP
  add/remove path emits manual guidance instead of mutating automatically.
- 0bc28df: Make daemon startup recovery retire authenticated terminal systemd registrations, including stale failed units, before proving absence and recreating the managed service. This completes the #663/#665 daemon startup-recovery lifecycle hardening.
- ddffca8: Remove newly created daemon temporary directories whose owner permissions were
  clipped by the process umask, and report an actionable retry requirement while
  preserving fail-closed validation for existing paths.
- a1c9e5e: Require an exact local runtime digest before doctor retries daemon-owned publication contention.
- ddb450f: Restore a minimal managed `~/.codex/AGENTS.md` memory-retrieval rule to the
  default Codex CLI connector bundle while preserving the detailed `lcm-memory`
  skill and native hooks. Existing user rules remain intact, explicit Codex MCP
  bundles omit the CLI-only entry, and reinstalling remains byte-idempotent.
- 4e8b2fd: Retain the authenticated reconciliation journal directory throughout each
  locked mutation attempt so normal and blocked-state journal writes detect a
  replaced parent and fail closed. Refuse lock-contention retries when that
  authenticated directory changed during the attempt.
- 265b46a: Retry daemon storage-factory cleanup once in the same terminal pass after a
  rejected close while preserving concurrent close coalescing and
  successful-close idempotence.
- c2a6d71: Preserve Codex PostToolUse events across typed publication-lock contention and
  surface fail-closed publication admission failures through a fixed,
  credential-free diagnostic and protocol-safe `systemMessage` with documented
  recovery guidance.
- fbea2ff: Migrate authenticated legacy Linux daemons only after their PID file disappears during exact stop, bind bounded systemd stop/final polling to the exact authenticated invocation ID until unit absence, and refuse every discoverable unit that is not fully authenticated running or PID evidence whose descriptor cannot be closed safely.
- 2ecc6b4: Make the PostgreSQL development harness recover proven stale Docker resources safely and clean up local test consumers reliably after process termination.
- 9ee092d: Reject accessor-backed and symbol-bearing promoted metadata arrays before reading their values.
- b37a2bd: Harden describe and expand compatibility handlers by sanitizing fallback error
  messages before response serialization, without changing their external HTTP
  status or response shape.
- 89c83fb: Keep public daemon health storage-free and path-free while retaining authenticated health diagnostics for lifecycle checks, clients, and doctor.
- 1e5ebcd: Require authenticated Git metadata backlinks and contained common directories while parsing bounded worktree configuration without backtracking.
- 0d5f4a5: Reject foreign-owner or multiply linked project metadata before using it to
  restore missing project-map entries.
- 31a61a2: Reject multiply linked or owner-mismatched project metadata before project
  admission can parse or rewrite it, while preserving early metadata creation and
  malformed snapshot recovery.
- b34389f: Reject empty, removed, or rebound backend-publication evidence directories
  instead of treating them as legacy SQLite installations without publication
  evidence.
- ff568a0: Reject untrusted ownership and hard links on canonical reconciliation metadata
  before parsing or reusing its content.
- dab7f57: Update the bundled URI parser to a patched release that prevents backslash authority host confusion while preserving the deduplicated MCP SDK and AJV build graph.
- 46c5955: Clean up Codex configuration resolver witnesses after proven failure, abort,
  and timeout settlement while retaining unproven witnesses for reconciliation.
- bcc9bab: Skip portable source page reads for authenticated authoritative-empty domains
  and return their canonical empty terminal batches.
- e3ed05a: Keep healthy managed daemons admissible when callers differ only in shell locale or time-zone presentation settings.
- 10f545c: Keep default managed daemon start, doctor, and restart calls on one packaged runtime identity, and wait through an exact bounded systemd stop transition before recreating the service.
- 33fe5d5: Managed background daemons now use a stable, private state-root temporary
  directory independent of the caller's `TMPDIR`, `TMP`, and `TEMP` values.
- e7baaba: Correct `lcm stats` compression output to compare compacted conversations with the total conversation count.
- 8dce7d9: Document the crash-recoverable backend-publication admission boundary, secure
  local state-root establishment, staged PostgreSQL privilege posture, and
  fail-closed operator behavior.
- aedab5f: Retry short authenticated root-bootstrap contention during a bounded window across CLI startup—20 total attempts at 50 ms intervals, up to about 950 ms—so read-only commands such as `lcm search` continue after a competing bootstrap completes, while ambiguous or unsafe lock states still fail closed.
- ca4502e: Run source and packaged SQLite diagnostic workers with the explicit Node flags
  required by the minimum supported runtime, retain authenticated SQLite pool
  counts across bounded collection timeouts, and preserve known backend identity
  when daemon statistics routes sanitize unexpected failures.
- 247c55e: Repair an authenticated managed daemon with stale service configuration during `lcm doctor` while preserving fail-closed lifecycle refusals and reporting the repaired restart.
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
- a909b21: Harden PostgreSQL test-process and orphan-resource teardown, and clean isolated Vitest homes at the end of each run.
- dbbd850: Prevent private mutation-lock ownership checks from executing process-birth helpers found through an untrusted `PATH` or working directory.
- e5c524c: Validate release markers and publication history with trusted default-branch policy before tagged package code is available.
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
