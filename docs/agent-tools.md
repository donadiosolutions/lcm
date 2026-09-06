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
For promoted searches, all required tags are applied before the caller's result
maximum, so the maximum counts eligible records.

The deprecated `semantic` layer name remains accepted as a compatibility input
and is normalized to `promoted`, but it is not advertised.

`limit` must be a positive integer from 1 through 1000. When omitted, it
defaults to 5. The value is a maximum applied independently to each selected
layer; episodic candidate recall grows to at least 50 records per store before
the final maximum is applied. Episodic results concatenate messages first and
then summaries, so a message-heavy result can fill the maximum before a
summary appears. Invalid values return HTTP 400 with `{ "error": "invalid limit" }`.

### lcm_grep

Search conversation history by keyword or regex across raw messages and summaries; interpretation follows the selected mode.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Keyword, phrase, or regex to search; interpretation follows the selected mode |
| `mode` | string | | `full_text` | `full_text` for literal/full-text matching or `regex` for regular-expression matching |
| `scope` | string | | `"both"` | `"messages"`, `"summaries"`, or `"both"` |
| `sessionId` | string | | — | Filter to a specific session |
| `since` | string | | — | Inclusive ISO datetime lower bound. Use `YYYY-MM-DDTHH:mm:ss` with optional 1-3 fractional digits and `Z` or `+/-HH:mm`; after offset normalization, UTC years must be 0001-9999. Omit it to include all history. Malformed or out-of-range values return `{ "error": "invalid since" }` (HTTP 400). |

Omit `sessionId` to search the whole project. When supplied, it selects the
project's canonical newest conversation for that session identifier; an
unknown identifier returns empty `messages` and `summaries`. Values must be
nonempty strings without NUL characters, and the identifier is looked up byte
for byte without trimming or coercion. The `restore` flow has separate
historical-context behavior and is unaffected by this filter.

**Returns:** A JSON object with separate `messages` and `summaries` arrays and
`totalMatches`, equal to the number of hits in those arrays
(`messages.length + summaries.length`). Message hits contain `messageId`,
`conversationId`, `role`, `snippet`, and `createdAt`; summary hits contain
`summaryId`, `conversationId`, `kind`, `snippet`, and `createdAt`. The
`conversationId` on each hit is the numeric internal conversation identity.
On the wire, `createdAt` is an ISO 8601 UTC string. Each hit may also include
an optional numeric `rank`; it is a backend relevance value without a uniform
meaning across search modes or hit types. The input `sessionId` is a string
filter resolved to a conversation and is not returned on hits, and neither hit
type has a `type` field.

A successful search with no matches, including an unknown `sessionId`, returns
`{ "messages": [], "summaries": [], "totalMatches": 0 }`. If `cwd` is
missing or invalid, the project is unavailable, or an unclassified error is
encountered, the HTTP fallback may instead return the legacy
`{ "matches": [] }` body. Validation and storage-admission failures retain
their error responses, so an empty body does not represent every failure.

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
fraction and a required `Z` or numeric `+/-HH:mm` timezone. After offset
normalization, the UTC year must be 0001 through 9999 inclusive. Omit `since`
to search all history; malformed or out-of-range values return
`{ "error": "invalid since" }` (HTTP 400) before project validation or storage
access.

The deprecated `all` scope remains accepted as a compatibility input and is
normalized to `both`, but it is not advertised. The package
`SearchResult.promoted` property matches the daemon's existing runtime
response; the previously published `semantic` property was never populated.

### Daemon JSON request bodies

The `/describe`, `/expand`, `/grep`, `/recent`, `/search`, `/store`, `/ingest`,
`/restore`, `/promote`, `/status`, `/session-complete`, `/promote-events`,
`/promote-events/notify`, and `/review-stale` daemon endpoints require a JSON
object as the top-level request body. Top-level `null`, arrays, strings,
numbers, and booleans receive HTTP 400 with
`{ "error": "invalid request body" }` before route storage or processing
effects. An empty body keeps its existing `{}` fallback, and malformed JSON
syntax keeps each endpoint's existing error behavior. In particular,
`/recent` now rejects a non-object body instead of treating some primitives as
an empty request.

### HTTP `POST /search`

The daemon's `/search` endpoint searches episodic and promoted memory for a
project. Send a JSON object with an existing absolute project directory as
`cwd`, the search `query`, and any optional search parameters:

```json
{
  "cwd": "/workspace/project",
  "query": "authentication decision",
  "limit": 10,
  "layers": ["episodic", "promoted"],
  "tags": ["decision", "project:lcm"],
  "projectId": "legacy-project-id",
  "threshold": 0.7
}
```

The daemon validates `cwd` and uses it to select project storage. There is no
implicit working-directory fallback. The legacy `projectId` and `threshold`
options are accepted and forwarded to the daemon, but `projectId` does not
select a project and `threshold` does not filter by similarity. Omit `cwd` to
preserve the legacy empty-result response (`{ "episodic": [], "promoted": [] }`).
When provided, `tags` filters promoted entries by all supplied tags; episodic
history remains unfiltered. All required promoted tags are applied before the
caller’s result maximum, so the maximum counts eligible records. Omitted or
empty `tags` arrays do not filter either layer.

The package root exposes the same request through `memory.search`:

```js
import { memory } from "@donadiosolutions/lcm";

const result = await memory.search("authentication decision", {
  cwd: "/workspace/project",
  layers: ["episodic", "promoted"],
  limit: 10,
  tags: ["decision", "project:lcm"],
});
```

### HTTP `POST /recent`

The daemon's `/recent` endpoint returns recent summaries for a project. Send a
JSON object with `cwd` and an optional `limit`:

```json
{ "cwd": "/path/to/project", "limit": 5 }
```

`limit` must be a JSON number that is an integer from 1 through 1000. When it
is omitted, the endpoint uses 5. The endpoint does not coerce strings,
booleans, null, arrays, fractions, negative values, non-finite values, or
values above 1000. Invalid limits receive HTTP 400 with
`{ "error": "invalid limit" }` before `cwd` validation or storage access.

For a valid limit, a missing or invalid `cwd` retains the existing empty 200
response. Successful project requests return `{ "summaries": [...] }`; the
daemon client rejects non-2xx responses, including an invalid-limit response.

The package root exposes the same request through `memory.recent`:

```js
import { memory } from "@donadiosolutions/lcm";

const result = await memory.recent("/path/to/project", 5);
```

The first argument is an absolute project directory and is sent as `cwd`. If
you have an older call that supplied a project hash as `projectId`, migrate it
to the corresponding project directory; hashes are not interpreted as paths
and no ambient working-directory fallback is used. Once a project is admitted,
existing storage responses remain observable, including HTTP 409 identity
configuration failures and HTTP 503 PostgreSQL storage failures.

### HTTP `POST /compact`

The daemon's `/compact` endpoint compacts a session transcript for a project.
The package root exposes it through `memory.compact`:

```js
import { memory } from "@donadiosolutions/lcm";

const result = await memory.compact(
  "session-id",
  "/path/to/transcript.jsonl",
  "/path/to/project",
);
```

`memory.compact(sessionId, transcriptPath, cwd)` sends `session_id`,
`transcript_path`, and `cwd` to the daemon. The third `cwd` argument is
optional and defaults to the caller's current working directory when the
method is invoked. Supply an explicit absolute project directory when the
transcript is stored elsewhere or the caller's working directory is not the
project being compacted. Existing two-argument calls continue to work with
that invocation-time default. The daemon validates the project directory and
continues to return its existing compaction response or admission error.

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
| `depth` | integer | | `1` | Positive number of DAG levels to traverse; no maximum |

`depth` defaults to `1` and must be a positive integer. Malformed explicit
values receive HTTP 400 (`invalid depth`) before `cwd` validation or project
admission. There is no upper bound beyond the positive-integer requirement.
The direct daemon request also follows the shared JSON-object body contract
above.

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

Show observed token savings, compression ratios, and numeric usage statistics
for the selected SQLite or PostgreSQL backend. The result uses the
[shared sanitized diagnostic snapshot](cli.md#observational-diagnostics), with
explicit readiness/failure states and a 2000-millisecond collection deadline.
Unavailable metrics are omitted, and no recalled-text previews, memory
payloads, raw errors, credentials, or local paths are returned. The invocation
does not bootstrap a daemon, migrate schema, register projects, or prune
sidecars. Starting an MCP connection remains a separate operational action.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `verbose` | boolean | | `false` | Include available detailed numeric statistics; the same privacy boundary applies |

### lcm_doctor

Observe the Long Context Manager (LCM) installation: existing-daemon health,
hooks, static MCP registration, and summarizer configuration. Reports findings
and explicit repair commands without starting or restarting services, changing
configuration, or repairing files. Live MCP protocol readiness is not probed;
doctor does not spawn a server for a handshake.

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
- `lcm_stats` may scan aggregate counters across projects; collection is bounded, but use it sparingly rather than in request handlers
- Token caps (`LCM_MAX_EXPAND_TOKENS`) prevent runaway expansion
