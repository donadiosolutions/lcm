# Configuration guide

## Quick start

### Claude Code

Install the `lcm` binary and add the plugin:

```bash
npm install -g @donadiosolutions/lcm  # provides the `lcm` command
claude plugin add github:donadiosolutions/lcm
lcm install
```

`lcm install` is the Claude Code setup path. It writes config, registers hooks, installs slash commands, registers MCP, and verifies the daemon.

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

The default Codex connector writes native hooks to `~/.codex/hooks.json`, enables Codex's current `hooks` feature in `~/.codex/config.toml`, installs the LCM skill at `.codex/skills/lcm-memory/SKILL.md`, and ensures the LCM rules block is present in `~/.codex/AGENTS.md`. Its hook set restores memory at session start, searches memory before prompts, captures passive tool-use signals, snapshots transcript deltas on `Stop`, and force-snapshots transcript deltas on `PreCompact` before manual or automatic Codex compaction. Use `lcm connectors install codex --type skill` or `lcm connectors install codex --type rules` only when you want one guidance surface without hooks.

For current limitations and the manual MCP step for Codex TOML config, see [`docs/vscode-codex.md`](vscode-codex.md).

Set recommended environment variables:

```bash
export LCM_FRESH_TAIL_COUNT=32
export LCM_INCREMENTAL_MAX_DEPTH=-1
```

Restart Claude Code.

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

## Daemon safety

The daemon listens on `127.0.0.1` only. lcm clients and hooks only build daemon requests to loopback HTTP origins and known daemon routes, so a malformed config or caller cannot redirect daemon traffic to another host.

Use `lcm daemon start` to start or validate the managed background daemon. Use
`lcm daemon restart` after configuration changes; it validates the new
configuration before stopping the managed process, then starts the daemon with
the updated settings. On Linux, lcm prefers the current user's `systemd --user`
manager so the daemon remains a direct child of the user manager instead of
being orphaned under PID 1. `lcm daemon start --detach` is kept as a compatibility
alias for the same managed start behavior. Use `lcm daemon start --foreground`
only when you want the daemon to stay attached to the current terminal for
debugging.

`lcm doctor` verifies daemon health and, on Linux, repairs a healthy daemon that is not parented by the current user's systemd manager by restarting it through the managed start path. If the user systemd manager is unavailable, lcm falls back to the older detached spawn behavior and reports that the parent invariant is not satisfied.

Stored `daemon.port` values must be integers from `1` through `65535`; this includes values written with `lcm config set`. Port `0` is reserved for internal runtime overrides used by tests to request ephemeral binding and is not a valid `config.json` value because lifecycle commands must be able to reconnect to the configured port. `daemon.idleTimeoutMs` must be an integer from `0` through `86400000` milliseconds; `0` disables the idle timer.

Legacy `compaction.promotionThresholds.mergeMaxEntries` values are migrated to
`dedupCandidateLimit`. LCM migrates stored configuration and runtime overrides
independently before merging them: the current key wins when both names occur
in the same source, while runtime overrides continue to take precedence over
stored configuration.

When `lcm doctor` finds that `~/.claude/settings.json` has a malformed or
non-object JSON root, it treats the file as empty settings and rebuilds the
managed `mcpServers.lcm` entry instead of crashing. Other fields are preserved
when the settings root is a valid JSON object.

Hook error fallback logs write to `~/.lcm/logs/events.log`.

## Project path aliases

LCM records canonical project paths and aliases in `~/.lcm/map.json`. All project database paths, passive-learning sidecars, metadata, sensitive-pattern files, and search/promotion routes resolve through that map before choosing a project hash.

Use `lcm map list`, `lcm map show`, `lcm map add`, and `lcm map remove` to manage aliases. Manual edits are supported; the daemon reloads valid changes without restart, pretty-prints valid non-canonical JSON, and keeps the last valid in-memory map during transient invalid saves.

See [Project path aliases](project-map.md) for the file format, backup behavior, ambiguity rules, and command reference.

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

Codex strict configuration validation is enabled when LCM supplies a reasoning
effort or enables fast mode. A default-off or explicitly disabled fast mode uses
only the process-local feature and `default` tier overrides, so unrelated fields
in the user's Codex configuration do not become fatal to ordinary compactions.

```json
{
  "llm": {
    "provider": "codex-process",
    "reasoningEffort": "high",
    "fastMode": true
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

`llm.requestTimeoutMs` defaults to `600000` milliseconds. The default retry
policy is `maxAttempts: 3`, `initialDelayMs: 1000`, `maxDelayMs: 30000`, and
`multiplier: 2`. `maxAttempts` includes the initial request. LCM disables the
OpenAI SDK's internal retries and applies this one bounded exponential-backoff
policy, so configured attempt counts remain exact.

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

Override the policy for one manual compaction without rewriting the file:

```bash
lcm compact \
  --timeout-ms 120000 \
  --retry-max-attempts 4 \
  --retry-initial-delay-ms 500 \
  --retry-max-delay-ms 10000 \
  --retry-multiplier 2
```

The CLI values merge over the JSON policy for that invocation and require the
OpenAI-compatible provider.

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
`llm.apiMode`, `llm.requestTimeoutMs`, and `llm.retry` are OpenAI-only and are
removed when switching to another provider. `llm.reasoningEffort` is preserved
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

In multi-agent Claude Code setups, each agent uses the same LCM database but has its own conversations (keyed by session ID). The plugin config applies globally; per-agent overrides use environment variables set in the agent's config.

## Disabling LCM

To fall back to Claude Code's built-in compaction:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "legacy"
    }
  }
}
```

Or set `LCM_ENABLED=false` to disable the plugin while keeping it registered.
