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

LCM no longer supports direct Claude Marketplace installation. During
installation, LCM detects recognized current and legacy LCM Marketplace
installations, removes them from their installed scopes while preserving their
data, and verifies that they are gone before writing the native integration.
Unknown or unrelated plugins are left unchanged. If automatic removal fails,
the installer stops before registering hooks so the two integrations cannot
run simultaneously.

To update:

```bash
npm install -g @donadiosolutions/lcm@latest
lcm install
lcm doctor
```

The hook commands and MCP server use absolute paths into the installed npm
package. `lcm doctor` validates the native configuration and managed daemon;
repair or reinstall with `lcm install`.

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
lcm connectors install github-copilot
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

The default Codex connector writes native hooks to `~/.codex/hooks.json`, enables Codex's current `hooks` feature in `~/.codex/config.toml`, installs the LCM skill at `.codex/skills/lcm-memory/SKILL.md`, and ensures the LCM rules block is present in `~/.codex/AGENTS.md`. Its hook set restores memory at session start, searches memory before prompts, captures passive tool-use signals, snapshots transcript deltas on `Stop`, and force-snapshots transcript deltas on `PreCompact` before manual or automatic Codex compaction. Use `lcm connectors install codex --type skill` or `lcm connectors install codex --type rules` only when you want one guidance surface without hooks.

For current limitations and the manual MCP step for Codex TOML config, see [`docs/vscode-codex.md`](vscode-codex.md).

Set recommended environment variables:

```bash
export LCM_FRESH_TAIL_COUNT=32
export LCM_INCREMENTAL_MAX_DEPTH=-1
```

Restart Claude Code after installing or repairing the native integration.

## Connector scope

The connector manager can install into either the current project or your global
agent config. For Codex, the global target is `~/.codex/`. GitHub Copilot is repo-scoped in this project today.

```bash
# Install the Codex native hook connector globally instead of into the current repo
lcm connectors install codex --global

# Inspect or remove the global connector later
lcm connectors doctor --global
lcm connectors remove codex --global
```

Use the global flag when you want Codex to pick up the connector from your
user-level config rather than a single repository checkout.

`lcm install` does not configure VS Code or Codex connectors today. Use `lcm connectors install ...` for those clients.

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
  invalid identity remains `409` and a staged backend remains `503`.
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

The PostgreSQL configuration, internal PostgreSQL 18 runtime, and schema
baseline are available for development and adapter conformance. Machine and
project identity operations are enabled by #84. The conversation adapter from
#85 is available for conformance but is not routed through the daemon or CLI.
The native-transcript adapter from #86 is available to explicit programmatic
backfill and conformance; it does not add a daemon route or CLI command. Normal
transcript activation remains #224, and the remaining storage/domain
repositories stay staged until the #92 cutover. A valid `postgresql` selection
therefore starts the managed daemon, but other
storage-backed routes remain unavailable and return a sanitized `503` until
those repositories are activated. Managed start/restart recognizes that authenticated staged response
as daemon readiness; it does not treat PostgreSQL storage as ready and never
falls back to SQLite after an explicit PostgreSQL selection. The internal readiness contract also requires
the parity extensions at their current default versions in the `public` schema;
see the [PostgreSQL schema reference](postgresql-schema.md#required-extensions-and-postgresql-version).

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
project binding, or backend support are unavailable. Daemon startup and
restart may retain the authenticated staged process described above, but its
storage routes remain fail-closed. The hook behavior therefore does not provide
SQLite fallback or make the PostgreSQL repository backend available.

Store only non-secret pool and timeout settings in `~/.lcm/config.json`:

```json
{
  "storage": {
    "backend": "postgresql",
    "postgresql": {
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
lcm daemon restart
```

### Provisioning a PostgreSQL database

Provisioning is an explicit administrator workflow. First create a UTF-8
PostgreSQL 18 database, preload `pg_stat_statements`, install the required
extensions in `public`, and configure `storage.backend` as shown above. Use a
dedicated migration role that owns the database and any existing `lcm` schema;
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
that this runtime role will use:
[`postgresql-runtime-identity-grants.sql`](postgresql-runtime-identity-grants.sql),
[`postgresql-runtime-conversation-grants.sql`](postgresql-runtime-conversation-grants.sql),
[`postgresql-runtime-transcript-grants.sql`](postgresql-runtime-transcript-grants.sql),
and
[`postgresql-runtime-memory-grants.sql`](postgresql-runtime-memory-grants.sql).
Direct issue #90 coordination callers additionally use
[`postgresql-runtime-coordination-grants.sql`](postgresql-runtime-coordination-grants.sql).
Run them as an administrator, substituting the deployment's restricted runtime
role:

```bash
psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-identity-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-conversation-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-transcript-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-memory-grants.sql

psql "$LCM_POSTGRES_ADMIN_URL" \
  --set=lcm_runtime_role=lcm_runtime \
  --file docs/postgresql-runtime-coordination-grants.sql
```

The transcript grant permits immutable inserts, provenance reads, and bounded
checkpoint updates only; it grants no payload update, deletion, truncation, or
unrelated table access. Applying it makes the programmatic repository usable,
not the staged daemon/CLI routes. See
[PostgreSQL native transcripts](postgresql-native-transcripts.md) before
running an explicit backfill.
The memory grant permits direct use of the staged promoted-memory, recall,
redaction-administration, and session-coordination repositories. Deletes are
limited to their six owned mutable-state tables; generated search data is
removed with promoted memory, while identity, conversations, summaries,
transcripts, checkpoints, events, and leases are retained. See
[PostgreSQL memory and administration](postgresql-memory-administration.md).
The coordination grant permits project-scoped lease reads, bounded deletes,
column-limited acquisition/renewal/release updates, fencing-sequence `USAGE`,
and column-limited passive-inbox claims. It grants no inbox insertion,
completion, deletion, payload update, table truncation, sequence inspection or
restart, schema mutation, or unrelated-domain access. Applying it exposes only
the staged programmatic primitives described in
[PostgreSQL cross-machine coordination](postgresql-coordination.md); it does
not enable the application backend or start a worker.

Finally restore `LCM_POSTGRES_URL` to the restricted runtime-role URL, run
`lcm machine register`, pair projects explicitly, and restart the daemon.
Never leave the daemon or identity commands configured with migration-owner
credentials. See the [PostgreSQL schema reference](postgresql-schema.md) for
the exact extension, role, ownership, ACL, backup, and recovery contracts.

The URL must use the `postgresql:` scheme. Do not add `ssl`, `sslmode`,
`sslcert`, `sslkey`, `sslrootcert`, or other `ssl*` query parameters; LCM owns
TLS configuration and uses the required CA file for certificate verification.
The CA path must be absolute and resolve to a readable, non-empty regular file
no larger than 1 MiB (1,048,576 bytes). Directories, FIFOs, device nodes, and
other non-regular files are rejected before LCM reads certificate contents.
The runtime also rejects any URL query parameter or fragment, requires explicit
username, password, host, and database components, and does not consult `PG*`
environment variables. The CA and URL are the only TLS and endpoint authority.

For DigitalOcean Managed PostgreSQL 18 Standard Edition, download the cluster
CA certificate from the database's **Connection Details** page, save it in a
private user-readable location, and use the displayed connection string without
its TLS query parameters. Restart the daemon after changing the backend, URL,
CA file, pool size, or timeouts. On Linux, the managed user-systemd launch sends
`LCM_POSTGRES_URL` through `LoadCredential`; the non-secret CA pathname is
propagated as a normal environment value. `lcm config get storage --effective`
shows the CA path and tuning values but replaces the URL with `[REDACTED]`.

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
container workflow in [PostgreSQL development](postgresql-development.md). It
uses disposable credentials and databases and must not be pointed at a shared
or production PostgreSQL cluster.

## Daemon safety

The daemon listens on `127.0.0.1` only. lcm clients and hooks only build daemon requests to loopback HTTP origins and known daemon routes, so a malformed config or caller cannot redirect daemon traffic to another host. Before admitting a daemon for ordinary use, lifecycle checks require the PID file, `/health` PID, installed version, active storage backend, authenticated access, and exact `127.0.0.1` listener ownership to agree. An occupied port with missing or unverifiable identity is rejected rather than trusted. Daemons that predate backend identity are recognized as SQLite-only, so selecting PostgreSQL cannot silently reuse an existing SQLite process. During an explicit restart, the running daemon is authenticated by PID, installed version, listener ownership, and its local token without requiring it to already use the newly selected backend; the replacement must match the new backend. SessionSnapshot skips ingestion when bootstrap cannot verify daemon identity. PostToolUse also ignores payload-provided daemon ports and performs no network I/O.

Use `lcm daemon start` to start or validate the managed background daemon. Use
`lcm daemon restart` after configuration changes; it validates the new
configuration before stopping the managed process, then starts the daemon with
the updated settings. Because restart fails closed unless the running daemon
owns the configured listener, stop the daemon before changing `daemon.port`,
then start it again after saving the new port. On Linux, lcm prefers the current user's `systemd --user`
manager so the daemon remains a direct child of the user manager instead of
being orphaned under PID 1. `lcm daemon start --detach` is kept as a compatibility
alias for the same managed start behavior. Use `lcm daemon start --foreground`
only when you want the daemon to stay attached to the current terminal for
debugging.

The managed systemd service receives a trusted executable path rather than the
launching shell's `PATH`. It prepends the exact absolute launcher and runtime
directories to a fixed set of system directories when those directories are
outside the current project. Known global Node installations and the bundled
Codex runtime remain valid trust anchors only when
they are also outside the current project containment boundary. Canonical
per-user installations remain trusted when the command runs directly from the
user's home directory; similarly named directories rooted in a checkout do not. LCM
rejects trust anchors containing the platform's `PATH` delimiter, all
`node_modules` paths (including `npx` and `node_modules/.bin` launchers), the
current project directory or its checkout ancestors when invoked from a
subdirectory, and other project-local or shell-specific entries.
If no trusted absolute entrypoint is available, the service uses only the fixed
system directories. Put provider configuration in LCM settings or the
documented `LCM_*` environment variables.

On Linux, `lcm doctor` reads the effective `PATH` from the verified running
daemon process when checking process-provider CLIs. If that process environment
is unavailable, doctor falls back to the same deterministic restricted path
used for a new managed daemon.

`lcm doctor` verifies daemon health and, on Linux, repairs a healthy daemon that is not parented by the current user's systemd manager by restarting it through the managed start path. If the user systemd manager is unavailable, lcm falls back to the older detached spawn behavior and reports that the parent invariant is not satisfied.

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

When `lcm doctor` finds that `~/.claude/settings.json` has a malformed or
non-object JSON root, it treats the file as empty settings and rebuilds the
managed `mcpServers.lcm` entry instead of crashing. Other fields are preserved
when the settings root is a valid JSON object.

Hook error fallback logs write to `~/.lcm/logs/events.log`.

## Local filesystem protection

LCM keeps `~/.lcm` and its project, event, and temporary directories accessible only to the current user (`0700`). Configuration, metadata, database, token, map, backup, and lock files use private file permissions (`0600`). Existing LCM roots are tightened during startup and installation.

Session restore locks use a SHA-256 digest of the agent session ID under `~/.lcm/tmp`; session IDs are never used as path components. LCM reads restored `AGENTS.md` and `CLAUDE.md` instructions only from regular, non-symlink files inside their expected roots, with a combined 1 MiB limit. Unsafe instruction files are skipped.

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
