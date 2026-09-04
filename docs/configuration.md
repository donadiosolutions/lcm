# Configuration guide

LCM requires Node.js 22.12.0 or newer.

## Quick start

### Claude Code

Install LCM from npm and configure its native Claude Code integration:

```bash
npm install -g @donadiosolutions/lcm@latest
lcm install
lcm doctor
```

`lcm install` is the Claude Code setup path. It writes the six native hooks to
`~/.claude/settings.json`, registers the npm-owned MCP server, installs slash
commands and skills, and verifies the daemon. The operation is idempotent, so
rerun it after updating the npm package.

During `lcm install`, `~/.claude/skills/lcm-memory/SKILL.md` is migrated only
when it contains current generated content, the canonical managed marker, or
exact released content in the fixed historical digest allowlist. Any other
content difference—including other whitespace or newline variants or user
modifications—is preserved and the installation is refused.

LCM no longer supports direct Claude Marketplace installation. During
installation, LCM writes and reads back its native hook and MCP settings before
removing any recognized current or legacy LCM Marketplace installation. It
then removes those plugins from their installed scopes while preserving their
data, verifies that they are gone, and reconciles the native settings again in
case Claude changed the file during removal. Unknown or unrelated plugins are
left unchanged. If the native settings cannot be persisted, the Marketplace
integration remains untouched. If automatic removal fails after native setup,
the installer reports the failure and leaves the native settings in place; fix
the reported Claude plugin error and rerun `lcm install`.

To update:

```bash
npm install -g @donadiosolutions/lcm@latest
lcm install
lcm doctor
```

On Linux, an upgrade from LCM v1.4.1 to v1.4.2 can leave one authenticated
legacy transient systemd service running while the new stable service name is
absent. The first `lcm doctor` after the upgrade, or an explicit
`lcm daemon restart`, performs a one-time migration only when the manager PID,
systemd invocation ID, canonical PID/token files, authenticated health
identity, older same-line version, process entrypoint, and loopback listener
all agree. A changing, ambiguous, symlinked, malformed, or unauthorized
candidate is not stopped and does not trigger a competing start. After exact
stop, the stable daemon starts only if the authenticated legacy daemon removed
its own PID file. Any remaining PID pathname is preserved without unlinking
and blocks stable start.
While systemd retires the already-authenticated unit, LCM may wait through a
bounded `deactivating` stop/final substate only when the manager still reports
the same nonzero invocation ID and either the original PID or PID 0 as part of
that same shutdown. This post-stop observation never authorizes the stop and
does not count as success; the manager must report the exact unit absent before
migration can continue.
When the PID file is already missing, bounded strict discovery must prove that
no legacy candidate exists before normal absent startup continues; a candidate
in any discoverable systemd state, including reloading, refreshing,
activating, deactivating, maintenance, inactive, or failed, blocks startup
unless exact manager state proves it disappeared. A PID descriptor close
failure also invalidates the evidence and stops migration before any service
or pathname mutation. See the [managed daemon recovery guide](daemon-restart-recovery.md#one-time-migration-after-a-linux-upgrade)
for the checks and safe refusal behavior. Never stop a wildcard service or
start a second daemon manually during an upgrade.

The hook commands and MCP server use absolute paths into the installed npm
package. LCM owns the MCP entry's `type`, `command`, and `args`; `env` and any
other compatible user- or Claude-managed options, sibling MCP servers, and
unrelated settings are preserved across installation and doctor repair. When
normalizing an HTTP or SSE entry to `stdio`, LCM removes the incompatible
`url`, `headers`, and `transport` fields. `lcm doctor` validates the native
configuration and managed daemon; repair or reinstall with `lcm install`.

The published CLI contains its MCP SDK build graph in `dist/lcm.mjs`. Consumer
installations therefore do not receive a second external SDK, Express, or AJV
dependency path from LCM. The exact SDK, `body-parser`, and `fast-uri` versions
used to build that runtime remain pinned with lockfile integrity in the source
package. LCM builds with `fast-uri` 4.1.2; AJV retains its nested patched
`fast-uri` 3.1.5 dependency path, without exposing a second URI parser path in
consumer installations.

LCM's optional OpenAI integration requires the OpenAI SDK 7.3.0. The SDK is
pinned as both a development dependency and an optional peer dependency; use
Node.js 22.12.0 or newer.

When the setup wizard's **Custom server** summarizer is selected, both the
OpenAI-compatible server URL and model name are required. The wizard retries an
empty value once. If the retry is also empty, it falls back to the native CLI
default and does not save a partial custom-server configuration. Installer
health polling uses a bounded monotonic deadline, so wall-clock adjustments do
not extend or shorten the verification window.

### VS Code (GitHub Copilot)

Install the repo-local connector:

```bash
npm install -g @donadiosolutions/lcm
lcm connectors install github-copilot --transport cli
lcm connectors doctor github-copilot
```

This writes `.github/skills/lcm-memory/SKILL.md` in the current repository.

### Codex

Install the Codex connector:

```bash
npm install -g @donadiosolutions/lcm
lcm connectors install codex
lcm connectors doctor codex
```

Import historical Codex sessions with:

```bash
lcm import --codex
lcm import --provider all
```

Claude imports recognize both current flat transcripts
(`<project>/<session-id>.jsonl`) and legacy nested transcripts
(`<project>/<session-id>/<session-id>.jsonl`). When both layouts contain the
same session, the flat transcript is preferred; other similarly named files and
subagent transcripts remain independent. Files with equal modification times
are imported deterministically by session ID and then path.

The default Codex connector is the CLI bundle. It writes native hooks to
`~/.codex/hooks.json`, enables Codex's current `hooks` feature in
`~/.codex/config.toml`, and installs the LCM skill at
`.codex/skills/lcm-memory/SKILL.md`. It also appends one minimal managed rule to
`~/.codex/AGENTS.md` that requires Codex to use the `lcm-memory` skill before
starting substantive work or when it needs further project understanding.
Passive hook injection can satisfy routine context recovery without another
explicit search. Existing user content is preserved with one blank line before
the managed entry.
Its hook set restores memory at session start, searches memory before prompts,
captures passive tool-use signals, snapshots
transcript deltas on `Stop`, and force-snapshots transcript deltas on
`PreCompact` before manual or automatic Codex compaction. A fresh/default Codex
CLI install does not add, remove, or inspect MCP configuration.

Select one complete connector bundle with the transport option:

```bash
lcm connectors install <agent> [--transport cli|mcp] [--global]
lcm connectors remove <agent> [--global]
```

An explicit transport takes precedence over the stored
`connectors.transports.<agent-id>` value, which takes precedence over the
registry default. Implicit defaults are not persisted. MCP is the default only
for Claude Code, Qwen Code, and Zed; Codex and every other agent default to
CLI. Cline and Augment remain CLI-only until verifiable MCP adapters exist.
CLI bundles use skill guidance when supported, rules as a fallback, and native
hooks where implemented. MCP bundles use the MCP connector and transport-pure
guidance, plus native hooks where implemented. There is no fallback between
MCP and CLI guidance. Removal is whole-bundle and clears the stored choice
after the bundle is removed.

For Codex, choose MCP explicitly with
`lcm connectors install codex --transport mcp`. LCM uses the native `codex mcp`
commands for that bundle; no TOML editing is required. Return to the
default CLI bundle with `lcm connectors install codex --transport cli`. The
explicit MCP bundle does not retain or install the CLI-only managed
`~/.codex/AGENTS.md` entry.

On Linux, the nested native `codex mcp` commands receive the current user's
session bus only when both values form one authenticated canonical pair:
`XDG_RUNTIME_DIR=/run/user/<uid>` and
`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`. LCM verifies the
runtime directory is canonical, owned by that user, and mode `0700`, and that
the exact bus endpoint is a canonical user-owned socket. Missing, malformed,
oversized, control-character-bearing, foreign-user, redirected, non-socket,
or mismatched values are omitted together. Other process environment values
remain outside the native-command allowlist.

Connector install and removal protect filesystem-backed project and home
targets with Linux proc-descriptor-anchored traversal. Existing parent
directories are authenticated without following intermediate symlinks; missing
parents are then created one component at a time. The selected project root or
captured home root may itself be a symlink, but a redirected descendant parent
(including an in-root alias) is refused before connector files, native MCP
state, or the stored transport choice are mutated. Public results and errors
continue to use ordinary display paths. Removal failure lists and rollback
diagnostics apply the same redaction and do not expose retained
`/proc/self/fd` operation paths or an unsanitized nested error cause.

This guarantee is intentionally Linux-specific. Filesystem-backed connector
install/remove refuse on macOS, other non-Linux platforms, or when strict
directory/no-follow/nonblocking flags or `/proc/self/fd` descriptor lookup are
unavailable. Manual/no-write guidance, `lcm install`, `lcm doctor`, connector
listing, inventory inspection, and verified legacy read-only branches remain
usable. The traversal uses proc descriptors; it is not portable `openat` and
does not provide portable descriptor-relative compare-and-swap. Generic durable
configuration writes use an unconditional atomic rename after a bounded safety
preflight; their application locks coordinate cooperating LCM writers but are
not an operating-system compare-and-swap against arbitrary same-UID edits.
The legacy `expectedContentSha256` option is rejected before mutation. Callers
that need conditional replacement must use a protocol-specific operation; see
the [architecture contract](architecture.md#portable-durable-file-writes).

Within that Linux boundary, LCM stages every replacement in a private,
mode-0700 transaction directory. Before the public link exists, it creates an
immutable publication certificate containing SHA-256, exact size, full
permission/special-mode bits, and canonical decimal device/inode identities.
Existing leaves are claimed by an atomic rename and exact certificate
validation; complete candidates are published with a no-replace hard link.
Neither the public alias nor the retained private alias can become authority
after publication: a peer edit or chmod of both aliases fails certificate
verification and is preserved. LCM never truncates, writes, or chmods a public
leaf or its original inode. A wholly LCM-owned skill, rules file, or Codex
hooks file is physically removed after a validated claim. Historical empty
skills/rules and `{}` hooks remain recognized as neutral, not installed, and
reinstallable; removing one again is a no-op.

Connector leaves and requested replacements are limited to 4 MiB (4,194,304
bytes). LCM rejects an oversized leaf before allocating a read buffer or
starting a transaction, so the public connector path remains untouched.

Rollback is receipt-bound and namespace-only. It moves the current public entry
only when its immutable certificate still matches, then copies the stable
initial hold into a newly certified restore candidate and publishes that
candidate with a no-replace hard link. The original inode and any external hard
links are not restored; rollback guarantees logical bytes, exact size, and full
mode on a logically new inode. Concurrent edits, chmods, replacements,
symlinks, directories, and aliases are preserved; a non-linkable or mismatched
entry remains at a named recovery path and reports `rollback incomplete`.
Compensation runs in reverse mutation order and never recursively deletes
unknown files. Existing-leaf replacement has a short intentional `ENOENT`
window between claim and candidate publication, so a concurrent reader such as
Codex may briefly observe the hooks file as absent. The guarantee is
synchronous pathname-race preservation, not crash consistency: a process kill
or power loss may leave a transaction directory for manual inspection. A
same-inode write that changes A to B and back to A before observation is
necessarily indistinguishable from no change. This is Linux
`/proc/self/fd` anchoring, not portable `openat`, and it does not resolve the
generic durable-write contract in #681 or the #715 parent-path boundaries.

The default native Codex MCP runner can inspect canonical state, but automatic
`codex mcp add/remove` is refused because the child process mutates ordinary
pathname `CODEX_HOME`. Follow the emitted manual guidance, or supply an
explicit trusted `CodexMcpRunner` seam to programmatic callers. Read-only
inventory remains pathname-based and is not mutation-safety proof.

Set recommended environment variables:

```bash
export LCM_FRESH_TAIL_COUNT=32
export LCM_INCREMENTAL_MAX_DEPTH=-1
```

Restart Claude Code after installing or repairing the native integration.

## Connector scope

The connector manager can install into either the current project or your global
agent config. For Codex, the global target is `~/.codex/`. GitHub Copilot is
repo-scoped in this project today.

```bash
# Install the Codex native hook connector globally instead of into the current repo
lcm connectors install codex --global

# Inspect or remove the global connector later
lcm connectors doctor --global
lcm connectors remove codex --global
```

Use the global flag when you want Codex to pick up the connector from your
user-level config rather than a single repository checkout.

`lcm install` does not configure VS Code or Codex connectors today. Use
`lcm connectors install ...` for those clients.

## Tuning guide

### Context threshold

`LCM_CONTEXT_THRESHOLD` (default `0.75`) controls when compaction triggers as a fraction of the model's context window.

- **Lower values** (e.g., 0.5) trigger compaction earlier, keeping context smaller but doing more LLM calls for summarization.
- **Higher values** (e.g., 0.85) let conversations grow longer before compacting, reducing summarization cost but risking overflow with large model responses.

For most use cases, 0.75 is a good balance.

### Fresh tail count

`LCM_FRESH_TAIL_COUNT` (default `32`) is the number of most recent messages that are never compacted. These raw messages give the model immediate conversational continuity.

- **Smaller values** (e.g., 8–16) save context space for summaries but may lose recent nuance.
- **Larger values** (e.g., 32–64) give better continuity at the cost of a larger mandatory context floor.

For coding conversations with tool calls (which generate many messages per logical turn), 32 is recommended.

### Leaf fanout

`LCM_LEAF_MIN_FANOUT` (default `8`) is the minimum number of raw messages that must be available outside the fresh tail before a leaf pass runs.

- Lower values create summaries more frequently (more, smaller summaries).
- Higher values create larger, more comprehensive summaries less often.

### Condensed fanout

`LCM_CONDENSED_MIN_FANOUT` (default `4`) controls how many same-depth summaries accumulate before they're condensed into a higher-level summary.

- Lower values create deeper DAGs with more levels of abstraction.
- Higher values keep the DAG shallower but with more nodes at each level.

### Incremental max depth

`LCM_INCREMENTAL_MAX_DEPTH` (default `0`) controls whether condensation happens automatically after leaf passes.

- **0** — Only leaf summaries are created incrementally. Condensation only happens during manual `/compact` or overflow.
- **1** — After each leaf pass, attempt to condense d0 summaries into d1.
- **2+** — Deeper automatic condensation up to the specified depth.
- **-1** — Unlimited depth. Condensation cascades as deep as needed after each leaf pass. Recommended for long-running sessions.

### Summary target tokens

`LCM_LEAF_TARGET_TOKENS` (default `1200`) and `LCM_CONDENSED_TARGET_TOKENS` (default `2000`) control the target size of generated summaries.

- Larger targets preserve more detail but consume more context space.
- Smaller targets are more aggressive, losing detail faster.

The actual summary size depends on the LLM's output; these values are guidelines passed in the prompt's token target instruction.

### Prompt recall budgeting

Prompt-time recall now has a second budget layer after `/prompt-search` ranking.

- `restoration.promptSearchMaxResults` still controls how many top-ranked results the route aims to consider first.
- Setting `restoration.promptSearchMaxResults` to `0` disables prompt-memory
  recall completely, regardless of `maxInjectedMemoryItems`. SQLite returns an
  empty result immediately. PostgreSQL still performs machine registration,
  explicit project-binding, and storage-availability admission first, so an
  invalid identity remains `409` and an unavailable selected backend remains
  `503`.
- `restoration.promptSnippetLength` still controls the per-result snippet size before final emission.
- `restoration.maxInjectedMemoryItems` caps how many deduped hints can survive into the final `<memory-context>` block.
- `restoration.dedupMinPrefix` dedupes identical or near-identical hints by normalized prefix before emission.
- `restoration.maxInjectedMemoryBytes` caps the final prompt-time memory injection budget.
- `restoration.reservedForLearningInstruction` reserves room for `<learning-instruction>` before any hints are emitted.

In practice, the hook asks the daemon for ranked candidates, the daemon dedupes and trims them against the final byte budget, and only the emitted hints get surfaced back to the hook. That means increasing `promptSearchMaxResults` without adjusting `maxInjectedMemoryBytes` just gives the reranker more candidates to choose from; it does not guarantee more emitted context.

### Leaf chunk tokens

`LCM_LEAF_CHUNK_TOKENS` (default `20000`) caps the amount of source material per leaf compaction pass.

- Larger chunks create more comprehensive summaries from more material.
- Smaller chunks create summaries more frequently from less material.
- This also affects the condensed minimum input threshold (10% of this value).

## Storage backend

LCM uses SQLite by default. Existing installations and configurations that do
not contain a `storage` object continue to use the per-project databases under
`~/.lcm/projects/` without any additional setup:

```json
{
  "storage": {
    "backend": "sqlite"
  }
}
```

The PostgreSQL configuration, internal PostgreSQL 18 runtime, schema baseline,
and production project-storage factory are also used by the daemon and MCP
storage routes when `storage.backend` is explicitly `postgresql`. The factory
composes all nine shared repository contracts only after eager runtime-readiness
checks and per-project publication and identity admission. The native-transcript
adapter remains a separate explicit backfill seam and does not add a daemon
route or CLI command. SQLite remains the default; an explicit PostgreSQL
selection never falls back to a project SQLite database. The factory's
readiness contract also requires the parity extensions at their current default
versions in the `public` schema; see the [PostgreSQL schema reference](../src/storage/postgresql/reference/postgresql-schema.md#required-extensions-and-postgresql-version).
The separate [backend publication safety guide](backend-publication.md)
describes the secure `~/.lcm` root, publication journal, PostgreSQL admission
fence, and the `503`/doctor behavior when publication evidence is unresolved.

The installed no-override PreCompact command (`lcm compact --hook`) is a
best-effort exception to that fail-closed admission path. Before dispatch, its
wrapper does not resolve `LCM_POSTGRES_URL` or `LCM_POSTGRES_CA_FILE`. If the
configured backend is unavailable, the credentials are absent, or daemon
admission fails, the hook exits `0` with no output so it cannot block the
agent's own compaction. If an installed hook is customized with explicit
`--timeout-ms` or `--retry-*` flags, only the secret-free LLM request-policy
projection is loaded to validate those overrides; PostgreSQL credentials are
still not resolved before fail-open dispatch.

Manual CLI operations and MCP request admission are not covered by that hook
exception. They resolve the complete effective configuration and fail closed
when PostgreSQL credentials, TLS preflight, identity registration, explicit
project binding, or backend support are unavailable. The daemon starts one
selected-backend factory and routes bounded repository batches through it. An
unbound or invalid project returns sanitized `409` identity guidance; a
selected-backend initialization or operation failure returns a sanitized `503`.
The daemon cancels request-scoped work on client disconnect and drains active
consumers before closing the factory during shutdown. No PostgreSQL failure
opens a project SQLite database as a recovery path.

The following is the reserved PostgreSQL configuration shape for direct
development and conformance only; it is not an instruction to activate
PostgreSQL in a production installation. Store only non-secret pool and
timeout settings in `~/.lcm/config.json`:

```json
{
  "storage": {
    "backend": "postgresql",
    "postgresql": {
      "migrationRole": "lcm_migration",
      "poolMax": 5,
      "connectionTimeoutMs": 10000,
      "idleTimeoutMs": 30000,
      "statementTimeoutMs": 60000
    }
  }
}
```

| Setting | Default | Valid range |
| --- | ---: | ---: |
| `migrationRole` | none | non-empty, no control characters, 1-63 UTF-8 bytes |
| `poolMax` | `5` | `1`-`100` |
| `connectionTimeoutMs` | `10000` | `1`-`600000` |
| `idleTimeoutMs` | `30000` | `0`-`3600000` |
| `statementTimeoutMs` | `60000` | `1`-`3600000` |

Supply the connection URL and CA certificate path through the environment. LCM
rejects `url` and `caFile` keys in JSON so credentials cannot be persisted by
configuration commands:

```bash
export LCM_POSTGRES_URL='postgresql://USER:PASSWORD@HOST:25060/DATABASE'
export LCM_POSTGRES_CA_FILE='/absolute/path/to/ca-certificate.crt'
export LCM_POSTGRES_MIGRATION_ROLE='lcm_migration'
```

`migrationRole` is the expected owner of the database, the `lcm` schema, and
all managed schema objects. It is an authorization identity, not a credential,
so it may be stored in JSON. `LCM_POSTGRES_MIGRATION_ROLE` is the fallback only
when the JSON setting is absent; a configured JSON value wins. The factory
compares this value with PostgreSQL catalog ownership and rejects a runtime
role that is the migration owner, can assume it, or otherwise exceeds the
reviewed application privileges. Use the exact unquoted PostgreSQL role name
reported by the catalog; do not put a password or connection URL in this
setting.

These environment values are used by the daemon and MCP runtime as well as
direct programmatic callers. Run `lcm daemon restart` after changing the
selection or credentials so the managed daemon constructs a fresh verified
factory. The CLI/import-export activation and parity work remain tracked by
#618; stats, pool diagnostics, status, and doctor presentation remain tracked
by #619.

### Provisioning a PostgreSQL database

Provisioning is an explicit administrator workflow for any PostgreSQL daemon,
MCP, or programmatic deployment. First create a UTF-8 PostgreSQL 18 database,
preload `pg_stat_statements`, install the required extensions in `public`, and
configure `storage.backend` as shown above. Use a dedicated migration role that owns
the database and any existing `lcm` schema;
do not use the restricted runtime role for DDL. Then apply the migrations
packaged with the installed LCM version:

```bash
export LCM_POSTGRES_CA_FILE='/absolute/path/to/ca-certificate.crt'
LCM_POSTGRES_URL="$LCM_POSTGRES_MIGRATION_URL" lcm postgres migrate
```

Use `--json` for automation. The command opens the production PostgreSQL
runtime without requiring a pre-existing LCM schema, verifies the packaged SQL
and SHA-256 manifest, takes the migration advisory lock, validates PostgreSQL
18, extensions, ownership, history, and schema fingerprints, applies pending
migrations transactionally, and closes its pool before returning. Repeated and
concurrent invocations converge. It never installs extensions, repairs drift,
changes ownership, or grants application privileges.

After migration, apply only the reviewed scripts required by the repositories
that this runtime role will use. The project-storage factory requires the
readiness script and all six repository-domain scripts:
[`postgresql-runtime-readiness-grants.sql`](../src/storage/postgresql/reference/postgresql-runtime-readiness-grants.sql),
[`postgresql-runtime-identity-grants.sql`](../src/storage/postgresql/reference/postgresql-runtime-identity-grants.sql),
[`postgresql-runtime-conversation-grants.sql`](../src/storage/postgresql/reference/postgresql-runtime-conversation-grants.sql),
[`postgresql-runtime-summary-context-grants.sql`](../src/storage/postgresql/reference/postgresql-runtime-summary-context-grants.sql),
[`postgresql-runtime-memory-grants.sql`](../src/storage/postgresql/reference/postgresql-runtime-memory-grants.sql),
[`postgresql-runtime-search-grants.sql`](../src/storage/postgresql/reference/postgresql-runtime-search-grants.sql),
and
[`postgresql-runtime-coordination-grants.sql`](../src/storage/postgresql/reference/postgresql-runtime-coordination-grants.sql).
Apply the separate
[`postgresql-runtime-transcript-grants.sql`](../src/storage/postgresql/reference/postgresql-runtime-transcript-grants.sql)
only when the explicit native-transcript repository is used. Run every script
as the migration owner or an administrator with equivalent grant authority,
substituting the deployment's restricted runtime role. Applying a function
grant through the runtime role itself creates foreign-grantor ACL evidence and
is rejected by readiness even if the effective privilege appears equivalent:

```bash
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-readiness-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-identity-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-conversation-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-summary-context-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-memory-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-search-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-coordination-grants.sql

# Optional: explicit native-transcript import only.
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file src/storage/postgresql/reference/postgresql-runtime-transcript-grants.sql
```

The transcript grant permits immutable inserts, provenance reads, and bounded
checkpoint updates only; it grants no payload update, deletion, truncation, or
unrelated table access. Applying it makes the explicit native-transcript
repository usable; native-transcript daemon and CLI routing remains outside
this issue. See
[PostgreSQL native transcripts](../src/storage/postgresql/reference/postgresql-native-transcripts.md) before
running an explicit backfill.
The memory grant permits direct use of the selected promoted-memory, recall,
redaction-administration, and session-coordination repositories. Deletes are
limited to their six owned mutable-state tables; generated search data is
removed with promoted memory, while identity, conversations, summaries,
transcripts, checkpoints, events, and leases are retained. See
[PostgreSQL memory and administration](../src/storage/postgresql/reference/postgresql-memory-administration.md).
The coordination grant permits project-scoped lease reads, bounded deletes,
column-limited acquisition/renewal/release updates, fencing-sequence `USAGE`,
and column-limited passive-inbox claims. It grants no inbox insertion,
completion, deletion, payload update, table truncation, sequence inspection or
restart, schema mutation, or unrelated-domain access. Applying it exposes the
project-scoped primitives described in
[PostgreSQL cross-machine coordination](../src/storage/postgresql/reference/postgresql-coordination.md); it does
not start the separate explicit passive-delivery worker.

### Embedded PostgreSQL project lifecycle

After provisioning, explicit embedded callers use the curated factory and pass
`openProject` a trusted, complete `StorageIdentityContext`; see the
[exception-safe ESM example](../README.md#storage-backend). Its remote UUIDv7,
local project-map identity, registered machine UUIDv7, and exact lexical
selected path must come from authenticated LCM state already established by the
cwd-aware `lcm project create` or `lcm project link` boundary. The curated
subpath does not discover, create, link, or repair identity, and callers must
not substitute a canonical/shared-worktree path for the selected path. Invalid,
missing, or mismatched identity fails closed; migration witness hashes do not
supply identity or runtime authorization.

Ordinary callers omit `openProject`'s optional second argument. The factory then
takes two short authenticated publication snapshots around remote identity work
and requires them to agree. Only an owning internal coordination boundary that
already holds a live `BackendPublicationLockToken` may pass it and keep it live
across the call; the curated subpath exports neither the token type nor a token
constructor. Never forge a token, treat raw journal data as authority, or
bypass publication evidence. See the
[backend publication safety guide](backend-publication.md).

Always close both scopes in `finally`: close `ProjectStorage` first to abort and
settle only its project work, then close the factory to drain pending opens and
remaining projects and close the shared runtime. Preserve a primary operation
failure if either cleanup fails. This explicit lifecycle is also the cleanup
model used by daemon route operations and does not change SQLite's active
default.

Before opening project storage, restore
`LCM_POSTGRES_URL` to the restricted runtime-role URL, run `lcm machine
register`, pair projects explicitly, and complete backend publication. Factory
construction fails closed on unhealthy TLS/runtime state, ownership or schema
drift, incomplete migrations, extension/search drift, missing grants, or
overbroad grants. Project lookup/open fails closed on unresolved or changed
publication evidence and any remote identity mismatch. Correct the underlying
state and retry; do not bypass readiness, rewrite publication evidence, or
switch to SQLite as an automatic recovery path. To roll back an active
selection, publish a new authenticated selection targeting SQLite through the
same publication workflow, then restart the daemon. Never leave identity
commands configured with migration-owner credentials. See the [PostgreSQL schema reference](../src/storage/postgresql/reference/postgresql-schema.md) for
the exact extension, role, ownership, ACL, backup, and recovery contracts.

The URL must use the `postgresql:` scheme. Do not add `ssl`, `sslmode`,
`sslcert`, `sslkey`, `sslrootcert`, or other `ssl*` query parameters; LCM owns
TLS configuration and uses the required CA file for certificate verification.
The CA path must be absolute and resolve to a readable, non-empty regular file
no larger than 1 MiB (1,048,576 bytes). Directories, FIFOs, device nodes, and
other non-regular files are opened nonblocking and rejected before LCM reads
certificate contents, so a writerless FIFO cannot hang the operation.
The runtime also rejects any URL query parameter or fragment, requires explicit
username, password, host, and database components, and does not consult `PG*`
environment variables. The CA and URL are the only TLS and endpoint authority.

For DigitalOcean Managed PostgreSQL 18 Standard Edition, download the cluster
CA certificate from the database's **Connection Details** page, save it in a
private user-readable location, and use the displayed connection string without
its TLS query parameters. These PostgreSQL values are consumed by the daemon,
MCP, direct programmatic, and conformance paths. On Linux, the managed
user-systemd launch sends
`LCM_POSTGRES_URL` through `LoadCredential`; the non-secret CA pathname is
propagated as a normal environment value. `lcm config get storage --effective`
shows the CA path and tuning values but replaces the URL with `[REDACTED]`.

The daemon only accepts credentials that systemd exposed through a canonical
per-unit directory under `/run/credentials/`, the current user's
`/run/user/<uid>/credentials/` tree, or a validated `XDG_RUNTIME_DIR` with the
same `<runtime>/credentials/<unit>` shape. The runtime directory must be a
canonical, non-symlink `0700` directory owned by the current UID. The
credential directory must use systemd's read-only `0500` mode (the
user-manager directory is owned by the current UID), and each requested credential must be an allow-listed regular file with
systemd's read-only `0400` mode, one hard link, and no more than 1 MiB of
content. Credential IDs are bounded, must not be duplicated, and are rejected
as a set when any ID is unknown or malformed. Invalid, missing, replaced, or
oversized credentials are ignored without logging their path or contents; the
usual configuration validation then reports any required value that remains
unavailable.

Managed background starts cross one additional environment boundary. The
systemd or launchd manager may have inherited arbitrary variables from the
interactive session, but the daemon is launched through the trusted
`/usr/bin/env -i` executable with a bounded set of non-secret runtime values
(such as `HOME`, `PATH`, locale, timezone, and validated runtime socket
addresses). Process-based Claude and Codex providers also receive
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` only when each is an absolute, canonical,
user-owned private directory. For managed systemd and launchd starts, `PATH` is
synthesized from the trusted packaged daemon entrypoint and fixed system
directories so the service sees the same provider search path that `lcm doctor`
checks, even when the command was invoked through a user-level wrapper. Default
managed lifecycle calls use that same packaged entrypoint in their manager
arguments, keeping start, doctor, and restart admission on one stable identity.
Service identity metadata and credential-file markers are passed as
names and paths only. API keys and database URLs are never copied into argv,
unit properties, plist contents, or logs; the daemon reads them from the
private one-launch credential files after the manager has authenticated their
directory and per-file ownership, mode, and link metadata. Each authenticated
launchd credential file is a one-shot input: LCM consumes it during the first
configuration load and retains only an immutable in-memory startup snapshot
for later in-process `loadDaemonConfig` reloads, including the `lcm stats`
configuration read. It never reopens a missing, deleted, replaced, or tampered
one-shot file after that first authenticated load. To apply a changed managed
credential, run `lcm daemon restart` so the manager creates a new nonce-scoped
credential set. A staged managed credential therefore takes precedence over a
same-name ambient variable. Detached compatibility launches retain their
historical direct-environment behavior. The in-process launchd snapshot cache
admits at most 16 distinct valid contexts and never evicts an established
context; once the bound is reached, a new context is rejected before any
credential file is opened and its configured credential names are masked so
configuration fails closed. Production uses one context, while the fixed
allowance preserves deterministic isolation for in-process parallel tests. The
`env -i` process is a short-lived
same-user launch boundary; it does not grant a different privilege or user
identity, and the service manager remains the lifecycle authority. A running or
otherwise executable managed launch must authenticate the current identity-
bearing environment exactly. Locale and time-zone presentation variables
(`LANG`, `LANGUAGE`, `LC_ALL`, `LC_COLLATE`, `LC_CTYPE`, `LC_MESSAGES`,
`LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`, and `TZ`) remain bounded child-launch
values but are intentionally excluded from manager identity, so a healthy
stable unit remains admissible when callers use different shell presentation
preferences. Other allow-listed values, such as `PATH`, `HOME`, socket
addresses, provider configuration, and the PostgreSQL CA pathname, remain
identity-bound. If one of those identity-bearing values changes while an old
launch descriptor remains, LCM never executes that old descriptor. After the
manager has independently proved exact absence, LCM may authenticate the old
descriptor's bounded, non-secret allow-listed values solely to remove its
canonical plist and owned credential directory before writing a new descriptor
with the current values. Malformed, out-of-scope, or uncontrolled descriptors
still fail closed and remain as collision evidence.

When the Claude process provider is used, `CLAUDE_CODE_OAUTH_TOKEN` is staged
through the same private one-launch credential mechanism. It is restored only
inside the authenticated Claude child environment; it is never placed in
systemd properties, launchd plist contents, command arguments, or diagnostics.

PostgreSQL is remote-primary: once repository support is enabled, an outage is
reported rather than silently switching the authoritative store to SQLite.
Hook capture remains local through the SQLite outbox so events can be queued
during daemon or database downtime and promoted after service recovery.
The outbox is not a cache, dual-write target, offline read replica, or fallback
for project-memory reads. See the
[storage repository architecture](architecture.md#storage-repository-architecture)
for backend ownership, transaction, capability, health, and adapter-extension
contracts.

Developers implementing a PostgreSQL repository should use the isolated
container workflow in [PostgreSQL development](../src/storage/postgresql/reference/postgresql-development.md). It
uses disposable credentials and databases and must not be pointed at a shared
or production PostgreSQL cluster.

## Daemon safety

The daemon listens on `127.0.0.1` only. lcm clients and hooks only build daemon
requests to loopback HTTP origins and known daemon routes, so a malformed config
or caller cannot redirect daemon traffic to another host. A managed daemon's
unauthenticated `GET /health` response is a constant-cost, storage-free liveness
probe containing only status, package version, selected backend, uptime, and
PID. It does not inspect project databases or expose installation paths.
Supplying a valid daemon bearer token returns the full storage-backed health
diagnostic; supplying an invalid credential returns `401`. Embedded and test
callers that intentionally create a daemon without a token retain the full
health response. `lcm doctor` treats public health as liveness only and uses the
authenticated post-validation health result to decide whether passive-learning
queues can drain, both when validating an already-running managed daemon and
after starting one. Authenticated healthy storage is ready, authenticated
storage is unavailable, and a missing or unreadable managed-daemon token leaves
readiness unverified. In that unverified state, doctor warns that access to the
daemon token and authenticated diagnostics must be restored before it can
promise that queued events will drain. Embedded and test-only tokenless servers
do not relax this production doctor authentication requirement.

Before sending the bearer token or admitting a daemon for ordinary use,
lifecycle checks require the public `/health` PID and installed version, a
recognized active storage backend, the PID file, process liveness, and exact
`127.0.0.1` listener ownership to agree. Authenticated full health and
`/stats/pool` then prove diagnostic access and the entrypoint identity. An
occupied port with missing or unverifiable identity is rejected rather than
trusted. Daemons that predate backend identity are recognized as SQLite-only,
so selecting PostgreSQL cannot silently reuse an existing SQLite process.
The PID, PID-file, and listener observations in this admission check are
consistency evidence for a responsive managed service; they are never offline
authority to signal or replace a process.
If bounded health checks remain unavailable while the exact PID-file process is
still a live likely-LCM process and still owns the configured listener,
lifecycle admission reports `connected: false` with a busy/unavailable warning
and preserves the process, PID file, and token. It revalidates that evidence
immediately before returning and does not signal, clean, or start a replacement
daemon. Retry after the current operation finishes. If health remains
unavailable after the daemon should be idle, run `lcm doctor` and one explicit
`lcm daemon restart`; if the service identity is ambiguous, the command
preserves the process and state and reports the next safe action.
During a responsive explicit restart, authenticated health and the owning
systemd/launchd service establish the existing service's identity; the
replacement must match the newly selected backend. A no-response or ambiguous
service has no offline PID, pathname, or token authority and is preserved rather
than signaled or replaced. SessionSnapshot skips ingestion when bootstrap
cannot verify daemon identity. PostToolUse also ignores payload-provided daemon
ports and performs no network I/O.

Use `lcm daemon restart` after configuration changes. It validates the complete
effective configuration before asking the host service manager to replace the
managed process, then waits for authenticated health. `lcm doctor` is the
canonical diagnostic command; it checks daemon health, service-manager
availability, hooks, connector registration, MCP setup, and summarizer
readiness. Do not start a second daemon to work around a health failure.

On Linux, the current user's `systemd --user` manager owns the background
service. On macOS, the current user's `launchd` agent owns it. LCM deliberately
does not configure an automatic restart policy (`Restart=` or `KeepAlive`). A
daemon that exits normally after `daemon.idleTimeoutMs` remains registered and
is recreated on the next lifecycle request, so idle terminals do not keep a
process alive while the service still has one authenticated owner.

Lifecycle health keeps the response boundary explicit. An HTTP response,
including an error status, malformed body, or a body timeout after headers, is
handled through the authenticated path. A transport deadline that expires
before any response is **no-response** and may request service-manager
recreation only after exact service ownership and state checks succeed. If the
caller cannot distinguish those outcomes, or the service identity is
ambiguous, recovery is refused and the process/state are preserved.

Detached/foreground compatibility launches, Windows, containers without a
per-user service manager, and any unsupported or ambiguous service are outside
managed recovery. Run `lcm doctor`, restore the host manager, and retry
`lcm daemon restart`. For stale client files after an upgrade, reinstall the
connector with `lcm connectors install <agent>` and verify it with
`lcm connectors doctor <agent>`; Claude Code's equivalent native repair is
`lcm install`. See [Managed daemon recovery](daemon-restart-recovery.md) for
the complete user-facing boundary and refusal guidance.

Recovery configuration is explicit and intentionally small.
`daemon.idleTimeoutMs` controls normal idle lifetime only; no configuration
value or force flag authorizes replacing a detached, foreground, or
no-response process offline. Restore the per-user service manager, run
`lcm doctor`, then use one explicit `lcm daemon restart`.

The service manager is LCM's ownership authority, but it is not a same-UID
filesystem security boundary. A process running as the same operating-system
user can read or modify that user's files and runtime state. Private file modes,
canonical paths, authenticated metadata, and manager identity checks reduce
accidental or cross-user access without providing capability-style isolation.

The MCP handshake check is time-bounded. If its helper process exits early,
stops accepting input, or encounters a pipe error, `lcm doctor` reports the
diagnostic as a warning and continues instead of waiting indefinitely or
crashing.

Stored `daemon.port` values must be integers from `1` through `65535`; this includes values written with `lcm config set`. Port `0` is reserved for internal runtime overrides used by tests to request ephemeral binding and is not a valid `config.json` value because lifecycle commands must be able to reconnect to the configured port. `daemon.idleTimeoutMs` must be an integer from `0` through `86400000` milliseconds; `0` disables the idle timer.

Legacy `compaction.promotionThresholds.mergeMaxEntries` values are migrated to
`dedupCandidateLimit`. LCM migrates stored configuration and runtime overrides
independently before merging them: the current key wins when both names occur
in the same source, while runtime overrides continue to take precedence over
stored configuration. `lcm config get` and `lcm config set` accept the legacy
path and report its canonical `dedupCandidateLimit` spelling.

When `lcm doctor` finds a malformed `mcpServers.lcm` value inside an otherwise
valid settings object, it replaces that entry with the minimal managed fields.
Malformed JSON, a non-object settings root, or a malformed `mcpServers`
container fails closed and must be corrected before repair. Other fields are
preserved when the settings root and server map are valid JSON objects.

Hook error fallback logs write to `~/.lcm/logs/events.log`.

## Local filesystem protection

LCM keeps `~/.lcm` and its project, event, and temporary directories accessible only to the current user (`0700`). Configuration, metadata, database, token, map, backup, and lock files use private file permissions (`0600`). Existing LCM roots are tightened during startup and installation.

Before `/promote` reads project scrub patterns or opens project storage, it
authenticates the private LCM root and project directory. Promotion refuses a
directory with the wrong owner or exact mode, a symlink, or topology that
changes during validation.

Session restore locks use a SHA-256 digest of the agent session ID under `~/.lcm/tmp`; session IDs are never used as path components. LCM reads restored `AGENTS.md` and `CLAUDE.md` instructions only from regular, non-symlink files inside their expected roots, with a combined 1 MiB limit. Unsafe instruction files are skipped.
Cached instructions are isolated by local project, machine, client, agent
session, verified worktree, and exact working directory. A compact/resume
restore reads only its exact scope; it does not fall back to another session or
worktree. Upgrades discard legacy fixed-slot instruction rows because they do
not contain enough provenance to assign safely.

Project-local transcript paths remain supported for normal working directories. A working directory equal to the filesystem root does not authorize every file on the machine; provider-managed Claude and Codex transcript directories remain available in that case.

## Machine and project identities

LCM records canonical paths, same-machine aliases, and optional PostgreSQL
project UUIDv7 bindings in `~/.lcm/map.json`. SQLite databases,
passive-learning sidecars, metadata, sensitive-pattern files, and local
search/promotion routes continue to use the path-derived local hash.

Use `lcm machine register|show|recover` for the private
`~/.lcm/machine.json`, and
`lcm project create|link|unlink|list|show|reconcile-worktrees` for project
identities and aliases. Verified linked Git worktrees share the primary
checkout's local SQLite identity and are consolidated on first storage access.
LCM accepts linked-worktree metadata only when the checkout `.git` pointer,
the shared `commondir`, the direct `worktrees/<name>` entry, and that entry's
`gitdir` backpointer authenticate one another. Missing, symlinked, foreign,
retargeted, or otherwise inconsistent topology fails before project storage is
opened.
PostgreSQL use fails closed until the machine
is registered and the local project is explicitly bound. Hooks retain passive
events in the local SQLite outbox during identity or PostgreSQL outages.

Manual map edits remain backward-compatible; the daemon reloads valid changes
without restart, pretty-prints valid non-canonical JSON, and keeps the last
valid in-memory map during transient invalid saves.

Codex import defaults to the current canonical project. `lcm import --codex
--all` considers every locally verified project. Deleted managed worktrees are
reassigned only from exact thread ownership or a unique repository URL under an
existing `~/.codex/worktrees/<token>` tombstone; unresolved and ambiguous
sessions are reported and skipped.

See [Machine registration and project identity](project-identity.md) for
permissions, recovery, pairing, stored-data guards, backup behavior, migration,
ambiguity rules, and the command reference.

## Model selection

LCM defaults to `LCM_SUMMARY_PROVIDER=auto`.

- In Claude sessions, `auto` resolves to `claude-process`
- In Codex sessions, `auto` resolves to `codex-process`
- If you explicitly set `LCM_SUMMARY_PROVIDER`, that override applies to both CLIs

You can pin a specific summarizer provider and model:

```bash
# Use a specific provider + model for summarization
export LCM_SUMMARY_MODEL=anthropic/claude-sonnet-4-20250514
export LCM_SUMMARY_PROVIDER=anthropic
```

Valid provider values are:

- `auto`
- `claude-process`
- `codex-process`
- `anthropic`
- `openai`
- `disabled`

For compatibility, `claude` and `claude-cli` are aliases for `claude-process`,
`codex` is an alias for `codex-process`, and `custom` and `openai-compatible`
are aliases for `openai`. Aliases are accepted in both `~/.lcm/config.json` and
`LCM_SUMMARY_PROVIDER`; LCM normalizes them to their canonical names.

`LCM_SUMMARY_PROVIDER` overrides `llm.provider`. `LCM_SUMMARY_MODEL` is applied
after JSON and runtime configuration are merged and overrides `llm.model`. An
explicitly empty `LCM_SUMMARY_MODEL` still overrides the file value, so remote
providers that require a model fail validation instead of silently using the
JSON value. When `LCM_SUMMARY_PROVIDER` switches away from an explicitly
configured provider and `LCM_SUMMARY_MODEL` is unset, LCM discards the old
provider-specific model. The configured model is preserved when the provider is
unchanged. For `claude-process` and `codex-process`, a non-empty effective model
is forwarded to the corresponding CLI with `--model`; an empty value preserves
the process backend's existing default-model behavior.

### LLM configuration

The `llm` object in `~/.lcm/config.json` selects the summarizer backend. This
example shows the OpenAI-specific fields and enables reasoning:

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-5.2",
    "apiKey": "${OPENAI_API_KEY}",
    "baseUrl": "https://api.openai.com/v1",
    "apiMode": "responses",
    "reasoningEffort": "medium",
    "maxConcurrency": 1,
    "requestTimeoutMs": 600000,
    "retry": {
      "maxAttempts": 3,
      "initialDelayMs": 1000,
      "maxDelayMs": 30000,
      "multiplier": 2
    }
  }
}
```

`baseUrl` is the canonical endpoint key. Legacy `baseURL` remains accepted so
existing configurations keep working. When only the legacy key is present, LCM
normalizes it to `baseUrl` in memory; configuration writes use only `baseUrl`.
If both keys are present with the same value, LCM accepts them, while conflicting
values fail validation.

`apiMode` accepts `chat-completions` or `responses`. It defaults to
`chat-completions`, preserving the existing OpenAI-compatible Chat Completions
behavior. Choose `responses` to use OpenAI's Responses API.

`reasoningEffort` is supported by OpenAI Responses and both process providers.
The accepted values depend on the configured provider:

- OpenAI Responses: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
- Claude process: `low`, `medium`, `high`, `xhigh`, `max`
- Codex process: `minimal`, `low`, `medium`, `high`, `xhigh`
- Stored `auto` configuration: `low`, `medium`, `high`, `xhigh`, the shared
  process-provider values

OpenAI Chat Completions does not accept reasoning effort. Individual provider
CLI versions and models may support only some otherwise valid values. LCM passes
the control through and treats the provider as authoritative, including
provider-accepted fallback behavior. A rejection produces a bounded diagnostic
with the provider, model, effort, and fast-mode state; prompts and credentials
are omitted.

The intersection applies only to `llm.reasoningEffort` stored with
`llm.provider: "auto"`, because that value must work for either process provider.
A one-invocation `--reasoning-effort` override under `auto` is validated against
the process provider resolved from the actual client. For example, a manual
batch resolves to Claude and can use `max`; a Codex hook can use `minimal`.

`fastMode` is a boolean supported by `auto`, `claude-process`, and
`codex-process`; it defaults to `false`. For Codex, LCM configures
`model_reasoning_effort`, the `fast_mode` feature, and the `fast` service tier
when enabled. When disabled, LCM disables the feature and selects the `default`
service tier so a global fast tier is not inherited. For Claude, LCM passes
`--effort` and process-local settings containing
the fast-mode selection. These controls apply only to the spawned summarizer
process and do not modify the user's provider configuration.

LCM passes Codex reasoning and fast-mode controls as process-local overrides
without enabling Codex strict configuration validation. This keeps unrelated,
forward-compatible fields in the user's Codex configuration from becoming fatal
to compaction while still applying the requested controls to the spawned
summarizer.

`llm.maxConcurrency` controls the number of manual compact requests that may be
in flight at once. It defaults to `1` and accepts only integer values from `1`
through `32`. The limit applies to active `/compact` requests, not to discovery,
progress rendering, or promotion. Newly compacted projects are promoted one at a
time in deterministic discovery order (the first compacted conversation for each
project), so increasing the limit does not make promotion concurrent.

The setting is read from the effective daemon configuration. A command-line
`--max-concurrency <n>` value has precedence for that invocation and never
rewrites `~/.lcm/config.json`; use `lcm config set llm.maxConcurrency <n> --json`
for a persistent default. The CLI accepts canonical unsigned decimal text only
(for example `4`, not `04`, `+4`, or `4.0`). Values outside `1..32` fail before
daemon registration or provider work. When `--replay` is selected, compaction
is always sequential: a stored value is silently clamped to `1`, while an
explicit `--max-concurrency` value above `1` is rejected because it would break
threaded replay ordering.

Use `--dry-run` to validate the complete configuration and discover eligible
conversations without starting the daemon, registering an invocation, sending
`/compact` requests, writing summaries, or promoting anything. Dry-run output is
therefore a preview, not a reservation of work.

Manual compact owns an invocation lease while it runs. A lost heartbeat,
daemon disconnect, expired lease, or client interruption moves that invocation
to cancellation and stops admitting new work. Work already admitted before
cancellation may finish its current atomic pass; no later pass may acquire a
durable-write permit. Queued work, active requests, provider retries, owned
provider processes/groups, and invocation-scoped promotion are drained before
the command exits. Promotion is skipped once draining begins.

For a catchable `SIGINT` (Ctrl+C), the command exits with status `130` after the
drain; `SIGTERM` exits with status `143`. A repeated signal does not bypass the
drain and reports that the command is still waiting for local work to settle.
These statuses are emitted only after the local and daemon-owned work reaches a
verified terminal state. A remote provider may still retain work it accepted
before cancellation; LCM cannot revoke that provider-side work. The local
guarantee is limited to zero LCM-owned queued/active work, SDK retry, provider
process/group, lock, and invocation-scoped promotion.

If a managed restart is needed during cancellation, LCM must prove that the old
daemon instance and its owned provider work disappeared before accepting a
replacement. If that proof is unavailable, the command remains in draining
state, reports the unproved condition, and fails closed rather than signaling an
unknown process or claiming that cancellation completed.

Codex-process compaction uses a private, one-use loopback Responses gateway for
each summarize call. The gateway binds only to `127.0.0.1` on an ephemeral port
and exposes a high-entropy capability path that accepts one exact
`POST /<capability>/responses` request. Codex runs from an empty per-call temporary
directory with user configuration, rules, and hooks disabled, and receives only
the fixed `LCM compaction bootstrap.` stdin string. The gateway keeps the real
LCM summarizer prompt and transcript in memory, replaces all inherited
`instructions` and `input` content, and sends a minimized Responses request
with no tools. The standard Responses dialect uses top-level `tools: []`; the
Responses Lite dialect uses an explicit empty `additional_tools` inventory.
Both force `tool_choice: "none"`, `parallel_tool_calls: false`, `store: false`,
and `stream: true`.

Only the validated model, reasoning controls, and supported service tier are
retained from Codex's request. `instructions`, `previous_response_id`,
`client_metadata`, `prompt_cache_key`, `include`, and `stream_options` are not
forwarded. The gateway requires one managed `Authorization: Bearer ...`
header. A bearer token beginning with `sk-` selects only
`https://api.openai.com/v1/responses`; any other valid managed bearer selects
only `https://chatgpt.com/backend-api/codex/responses`, whether or not a
`ChatGPT-Account-Id` is present. A valid account ID is forwarded when supplied,
but its absence does not select the public API route. Redirects and ambiguous
request or shutdown outcomes fail closed.

Gateway success follows the Responses protocol rather than an exact Codex CLI
version or HTTP transport EOF. LCM accepts only a complete, well-formed
`response.completed` event whose response status is `completed`, then closes the
one-use upstream stream itself. A client may close after consuming that terminal
event without turning a successful compaction into a failure. EOF before a
terminal event, malformed or mismatched SSE event data, bytes decoded after the
terminal frame in the same upstream chunk, and `response.failed` or
`response.incomplete` events fail closed. Once a valid terminal frame is
accepted, unread queued or future upstream bytes are canceled and never relayed.
This behavior has no configuration option.

```json
{
  "llm": {
    "provider": "codex-process",
    "reasoningEffort": "high",
    "fastMode": true,
    "requestTimeoutMs": 600000
  }
}
```

Override the configured effort for one manual compaction with:

```bash
lcm compact --reasoning-effort high
```

The CLI value takes precedence over `llm.reasoningEffort` for that invocation
and does not rewrite `~/.lcm/config.json`. Override the process fast-mode default
the same way:

```bash
lcm compact --fast-mode
lcm compact --no-fast-mode
```

When both fast-mode flags are supplied, the last flag wins. If neither is
supplied, `llm.fastMode` applies. These invocation overrides are also forwarded
by automatic Claude and Codex compaction hooks without rewriting configuration.

### Timeouts and retries

`llm.requestTimeoutMs` defaults to `600000` milliseconds and bounds each OpenAI,
Claude process, or Codex process request. The default OpenAI-only retry policy is
`maxAttempts: 3`, `initialDelayMs: 1000`, `maxDelayMs: 30000`, and
`multiplier: 2`. `maxAttempts` includes the initial request. LCM disables the OpenAI SDK's
internal retries and applies this one bounded exponential-backoff policy, so
configured attempt counts remain exact. Process providers do not retry because
relaunching a CLI process could duplicate expensive work.

With `llm.provider` set to `auto`, the timeout follows the effective process
provider: manual batch compaction resolves to Claude, while Claude and Codex
hooks resolve to their matching process provider. A one-invocation
`--timeout-ms` value is forwarded after that resolution, so it applies to the
actual Claude or Codex subprocess without enabling OpenAI retry behavior.

The timeout must be an integer from `1` through `3600000` milliseconds.
`maxAttempts` must be an integer from `1` through `10`; both delay values must
be integers from `0` through `600000` milliseconds; and `multiplier` must be a
finite number from `1` through `10`. `initialDelayMs` cannot exceed
`maxDelayMs`. Invalid JSON settings and CLI overrides fail before a provider
request is made.

LCM retries connection errors, timeouts, HTTP 408, 409, 429, and 5xx responses,
plus incomplete Responses API results. Authentication and configuration errors
and other 4xx responses fail immediately. Final diagnostics identify the safe
status or code and attempt count without including provider response bodies,
prompts, API keys, or URLs containing credentials.

Override the timeout for one OpenAI or process-provider manual compaction
without rewriting the file:

```bash
lcm compact --timeout-ms 300000
```

OpenAI-compatible providers additionally support one-invocation retry controls:

```bash
lcm compact \
  --timeout-ms 120000 \
  --retry-max-attempts 4 \
  --retry-initial-delay-ms 500 \
  --retry-max-delay-ms 10000 \
  --retry-multiplier 2
```

The CLI values merge over the JSON policy for that invocation. Retry flags
require the OpenAI-compatible provider.

### Local OpenAI-compatible server

Any server that exposes an OpenAI-v1 Chat Completions endpoint can use the
canonical `openai` provider. Set `llm.apiKey` when the custom endpoint requires
authentication; it may be omitted for local servers that ignore credentials.
LCM uses a non-secret local placeholder in that case and never borrows the
public OpenAI credential for another host.

```bash
export LCM_SUMMARY_API_KEY=local-server-token

lcm config set llm.baseUrl http://127.0.0.1:8000/v1
lcm config set llm.model local-model
lcm config set llm.apiKey '${LCM_SUMMARY_API_KEY}'
lcm config set llm.provider openai
lcm daemon restart
lcm compact --verbose
```

The single quotes store the environment-variable reference instead of the
secret itself. `LCM_SUMMARY_API_KEY` is propagated to managed daemon launches,
including the restart shown above.

The equivalent JSON is:

```json
{
  "llm": {
    "provider": "openai",
    "model": "local-model",
    "apiKey": "${LCM_SUMMARY_API_KEY}",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "apiMode": "chat-completions"
  }
}
```

### Inspecting and updating configuration

`lcm config get <path>` reads the normalized value stored in
`~/.lcm/config.json`. Add `--effective` to include defaults and environment
overrides used by the daemon:

```bash
lcm config get llm.provider
lcm config get llm.model --effective
lcm config get llm.fastMode --effective
```

`lcm config set <path> <value>` stores a string by default. Add `--json` for a
typed JSON value such as a number, boolean, object, array, or `null`:

```bash
lcm config set llm.model gpt-5-mini
lcm config set hooks.disableAutoCompact true --json
lcm config set llm.fastMode true --json
```

Secret-like values are recursively masked in both stored and effective output;
there is no raw-secret display mode. Writes validate the complete resulting
configuration, preserve unrelated keys, use a mode-`0600` temporary file, and
rename it atomically. A successful update prints `lcm daemon restart`, which
must be run before an existing daemon uses the change.

Changing `llm.provider` removes controls that the destination cannot use.
`llm.requestTimeoutMs` is retained when switching among `auto`, OpenAI, Claude
process, and Codex process providers. `llm.apiMode` and `llm.retry` are
OpenAI-only and are removed when switching to another provider.
`llm.reasoningEffort` is preserved
only when its value is valid for the destination provider; `llm.fastMode` is
preserved only when switching among `auto`, `claude-process`, and
`codex-process`. Provider aliases are normalized first, so `custom` and
`openai-compatible` retain OpenAI settings. Model, credential, endpoint,
extension, and other unrelated settings are preserved.

LCM validates `~/.lcm/config.json` strictly and fails loudly instead of silently
falling back. Malformed JSON, an `llm` value that is not an object, unknown
`llm` keys, invalid provider/API-mode/effort values, incorrect field types, and
missing provider requirements all stop daemon startup and compaction. `lcm
doctor` continues its remaining checks, reports the configuration failure using
the relevant JSON path, and exits nonzero. Errors redact `llm.apiKey` and do not
include secrets. For a valid OpenAI configuration, compact progress and doctor
diagnostics show the effective API mode and reasoning effort so an invocation
override is visible without exposing the request prompt.

Remote Anthropic configuration requires a non-empty model and resolved API key.
OpenAI requires a non-empty model and an absolute HTTP(S) `baseUrl`; the public
OpenAI endpoint also requires credentials. Process, `auto`, and `disabled`
providers do not require remote credentials.

Using a cheaper or faster model for summarization can reduce costs, but quality matters because poor summaries compound as they are condensed into higher-level nodes.

## Stale memory review

Promoted memories stay active indefinitely unless manually archived. Over time, some become stale: old project knowledge that is no longer correct or useful, but keeps surfacing.

LCM identifies stale candidates by combining age with recall feedback signals:

- **Age threshold** (`restoration.staleAfterDays`, default 90): memories older than this are evaluated for staleness.
- **Surfacing without use** (`restoration.staleSurfacingWithoutUseLimit`, default 5): if a memory has been surfaced this many times without ever being acted upon, it is a stale candidate.
- **Restore age limit** (`restoration.restoreMaxPromotedAgeDays`, default 180): the restore route suppresses promoted memories older than this.
- **Stale penalty** (`restoration.stalePenalty`, default 0.5): score penalty applied to stale candidates during prompt-time ranking.
- **Strong match override** (`restoration.allowStaleOnStrongMatch`, default true): when enabled, stale memories can still surface if their relevance score is high enough despite the penalty.

### Inspecting stale candidates

Call the `/review-stale` daemon endpoint with `{ "cwd": "/path/to/project" }` to list stale candidates with their surfacing and usage counts.

### Archiving and reviving

Stale candidates can be archived non-destructively. Archived memories are excluded from search and recall but remain in the database and can be revived later.

The `/review-stale` endpoint accepts `action: "archive"` or `action: "revive"` with a `target_id` to manage individual memories.

### Stats integration

Run `lcm stats --verbose` to see a summary of stale memory candidates across all projects.


## Database management

Each project's SQLite database lives at `~/.lcm/projects/<sha256-of-project-path>/db.sqlite`. The per-project path is derived automatically from the working directory.

### Inspecting the database

```bash
# Find your project hash
lcm stats

# Open the database (replace <hash> with your project hash)
sqlite3 ~/.lcm/projects/<hash>/db.sqlite

# Count conversations
SELECT COUNT(*) FROM conversations;

# See context items for a conversation
SELECT * FROM context_items WHERE conversation_id = 1 ORDER BY ordinal;

# Check summary depth distribution
SELECT depth, COUNT(*) FROM summaries GROUP BY depth;

# Find large summaries
SELECT summary_id, depth, token_count FROM summaries ORDER BY token_count DESC LIMIT 10;
```

### Backup

The database is a single file per project. Back it up with:

```bash
cp ~/.lcm/projects/<hash>/db.sqlite ~/.lcm/projects/<hash>/db.sqlite.backup
```

Or use SQLite's online backup:

```bash
sqlite3 ~/.lcm/projects/<hash>/db.sqlite ".backup /tmp/lcm-backup.sqlite"
```

## Per-agent configuration

In multi-agent Claude Code setups, each agent uses the same LCM database but
has its own conversation segments associated with its session ID. A session
may have multiple segments; LCM selects the newest one for get-or-create
operations. The native hook configuration applies globally; per-agent
overrides use environment variables set in the agent's config.

## Disabling LCM

Set `LCM_ENABLED=false` to disable LCM while keeping its native hooks
registered. Run `lcm uninstall` to remove the native Claude integration.
