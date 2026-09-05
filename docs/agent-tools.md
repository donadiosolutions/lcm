# Agent tools

LCM provides seven MCP tools for agents to search, inspect, store, and recall information from conversation history.

## Usage patterns

### Recall order

Use the least-expensive available context in this order:

1. **Injected memory** — Use the memory already present in the current context.
2. **`lcm_search`** — Broadly recall related knowledge across sessions when the injected memory is absent or insufficient.
3. **`lcm_grep`** — Find an exact keyword, error message, or function name only when broad recall is insufficient and a precise match is needed.
4. **`lcm_describe`** — Inspect a specific summary's metadata and lineage (cheap, no DAG traversal).
5. **`lcm_expand`** — Decompress a summary node into its full source content when the required detail was compressed away.

Do not start with `lcm_grep`: use broad recall first, then narrow to an exact
match only when necessary.

### When to search vs. grep

- **`lcm_search`** — Use after checking injected memory when looking for knowledge across sessions in natural language. Returns ranked results from both episodic (SQLite) and promoted memory layers.
- **`lcm_grep`** — Use only after broad `lcm_search` recall is insufficient and you need an exact keyword, error message, or function name.

### When to expand

Summaries are lossy by design. The "Expand for details about:" footer at the end of each summary lists what was dropped. Use `lcm_expand` when you need:

- Exact commands, error messages, or config values
- File paths and specific code changes
- Decision rationale beyond what the summary captured
- Tool call sequences and their outputs
- Verbatim quotes or specific data points

## Tool reference

### lcm_search

Hybrid search across episodic memory (SQLite FTS5) and promoted memory. Returns two separate ranked lists. Use when looking for project knowledge spanning multiple sessions. Results can include passively captured context after it has been indexed, in addition to explicitly stored durable memories.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Natural language search query |
| `limit` | integer | | `5` | Maximum results per layer, from 1 through 1000 |
| `layers` | string[] | | `["episodic", "promoted"]` | `"episodic"`, `"promoted"`, or both |
| `tags` | string[] | | — | Filter promoted entries to those that include all specified tags; episodic results remain unfiltered |

**Examples:**

```
# Find past decisions about authentication
lcm_search(query: "authentication decision")

# Search only promoted layer, filtered by tag
lcm_search(query: "database migration", layers: ["promoted"], tags: ["type:decision"])
```

Tags apply only to promoted memories, which are the tagged search records.
Episodic messages and summaries remain searchable without a tag predicate. Use
`layers: ["promoted"]` when you want tag-only recall; omitted or empty tags do
not filter either layer.

The deprecated `semantic` layer name remains accepted as a compatibility input
and is normalized to `promoted`, but it is not advertised.

`limit` must be a positive integer from 1 through 1000. When omitted, it
defaults to 5. The value is a maximum applied independently to each selected
layer; episodic candidate recall grows to at least 50 records per store before
the final maximum is applied. Episodic results concatenate messages first and
then summaries, so a message-heavy result can fill the maximum before a
summary appears. Invalid values return HTTP 400 with `{ "error": "invalid limit" }`.

### lcm_grep

Search conversation history by keyword or regex across raw messages and summaries.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Keyword, phrase, or regex to search |
| `mode` | string | | `full_text` | `full_text` for literal/full-text matching or `regex` for regular-expression matching |
| `scope` | string | | `"both"` | `"messages"`, `"summaries"`, or `"both"` |
| `sessionId` | string | | — | Filter to a specific session |
| `since` | string | | — | Inclusive ISO datetime lower bound. Use `YYYY-MM-DDTHH:mm:ss` with optional 1-3 fractional digits and `Z` or `+/-HH:mm`; omit to include all history. Invalid values return `{ "error": "invalid since" }`. |

Omit `sessionId` to search the whole project. When supplied, it selects the
project's canonical newest conversation for that session identifier; an
unknown identifier returns empty `messages` and `summaries`. Values must be
nonempty strings without NUL characters, and the identifier is looked up byte
for byte without trimming or coercion. The `restore` flow has separate
historical-context behavior and is unaffected by this filter.

**Returns:** Array of matches with content snippet, type (message or summary), and session ID.

**Examples:**

```
# Search for an error message across all history
lcm_grep(query: 'ECONNREFUSED')

# Search only summaries for a specific term
lcm_grep(query: 'config\\.threshold', scope: 'summaries')

# Interpret the query as a regular expression
lcm_grep(query: 'config\\.(threshold|limit)', mode: 'regex')
```

`since` is an inclusive lower bound. For example, `since: '2025-01-01T00:00:00Z'` includes matches created exactly at that instant and
later. The accepted form is `YYYY-MM-DDTHH:mm:ss` with an optional 1-3 digit
fraction and a required `Z` or numeric `+/-HH:mm` timezone. Omit `since` to
search all history; malformed values return `{ "error": "invalid since" }`
before project validation or storage access.

The deprecated `all` scope remains accepted as a compatibility input and is
normalized to `both`, but it is not advertised. The package
`SearchResult.promoted` property matches the daemon's existing runtime
response; the previously published `semantic` property was never populated.

### lcm_describe

Inspect metadata and lineage of a memory node without expanding content. Returns depth, token count, parent/child links, and whether the node was promoted to long-term memory.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nodeId` | string | ✅ | — | Node ID to describe (e.g. `sum_abc123`) |

**Examples:**

```
# Inspect a summary from context
lcm_describe(nodeId: "sum_abc123def456")
```

### lcm_expand

Decompress a summary node into its full source content by traversing the DAG. Use when a summary references details you need but doesn't include them verbatim.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nodeId` | string | ✅ | — | Summary node ID to expand |
| `depth` | number | | `1` | How many levels of the DAG to traverse |

**Examples:**

```
# Expand a leaf summary one level deep
lcm_expand(nodeId: "sum_abc123")

# Expand a condensed summary, traversing two levels
lcm_expand(nodeId: "sum_def456", depth: 2)
```

### lcm_store

Store a memory into Long Context Manager (LCM)'s semantic layer. Immediately
store each newly recognized durable decision, preference, root cause, pattern,
gotcha, solution, or reusable workflow, including its rationale.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | ✅ | — | The content to store |
| `tags` | string[] | | — | Canonical tags (see [tag-schema.md](tag-schema.md)) |
| `metadata` | object | | — | Optional key/value metadata |

**Examples:**

```
# Store an architectural decision
lcm_store(
  text: "Decision: Auth uses JWT with 24h expiry and httpOnly cookies. Rationale: this preserves stateless API verification while preventing client-side script access to tokens.",
  tags: ["type:decision", "scope:project", "project:lcm", "source:<actual-thread-uuid>"]
)

# Store a solution with sprint tag
lcm_store(
  text: "Fixed ECONNREFUSED by calling ensureDaemon before the request.",
  tags: ["type:solution", "scope:project", "project:lcm", "source:<actual-thread-uuid>"]
)
```

### lcm_stats

Show token savings, compression ratios, and usage statistics across all Long Context Manager (LCM) projects.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `verbose` | boolean | | `false` | Include per-conversation breakdown |

### lcm_doctor

Run diagnostics on the Long Context Manager (LCM) installation. Checks daemon, hooks, MCP config, and summarizer health.

**Parameters:** none.

## Tips for agent developers

### Configuring agent prompts

Add instructions to your agent's system prompt so it knows when to use LCM tools:

```markdown
## Memory & Context

Use LCM tools for recall in this order:
1. Use memory already injected into the current context.
2. Call `lcm_search` for broad recall when injected memory is absent or insufficient.
3. Call `lcm_grep` only when broad recall is insufficient and an exact match is needed; prefer single quotes for regex or shell-sensitive patterns.
4. Call `lcm_describe` for metadata and lineage when a specific result needs inspection.
5. Call `lcm_expand` only when a summary has compressed away detail you need.
6. Call `lcm_store` immediately for each newly recognized durable decision, preference, root cause, pattern, gotcha, solution, or reusable workflow. Include its rationale and exactly one `type:<classification>` tag, literal `scope:project` or `scope:user`, `project:<repo>`, and optional `source:<actual-thread-uuid>` when a real UUID is available.
7. When recalled memory affects the work, store one feedback memory per used memory with exactly one `type:feedback`, literal `scope:project` or `scope:user`, `project:<repo>`, optional `source:<actual-thread-uuid>` when a real UUID is available, and both `signal:memory_used` and `memory_id:<id>`.

When summaries in context have an "Expand for details about:" footer
listing something you need, use `lcm_expand` with that summary's node ID.
```

### Performance considerations

- `lcm_search`, `lcm_grep`, and `lcm_describe` are fast (direct database queries)
- `lcm_expand` traverses the DAG and reads source messages — cost scales with depth
- `lcm_stats` performs full-table scans — use sparingly, not in request handlers
- Token caps (`LCM_MAX_EXPAND_TOKENS`) prevent runaway expansion
