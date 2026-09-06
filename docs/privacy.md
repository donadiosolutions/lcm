# Privacy & Data Handling

Long Context Manager (LCM) stores your conversation history locally by default
to enable memory across sessions. This document explains exactly what is
stored, what leaves your machine, and how to control sensitive data.

## What is stored locally

With the default SQLite backend, all storage is on your machine:

- **`~/.lcm/projects/{hash}/db.sqlite`** — Conversation messages, summaries, and promoted long-term memory for each project. The hash is a SHA-256 of the project directory path.
- **`~/.lcm/projects/{hash}/meta.json`** — Local project identity and route
  timestamps. During preliminary project-directory initialization with
  metadata writing enabled, LCM reads at most 1 MiB from a single-link regular
  file whose owner matches the private LCM directory. Oversized, linked,
  non-regular, or owner-mismatched metadata is rejected before its contents are
  parsed or rewritten. Missing metadata is created; malformed or non-object
  metadata is rebuilt; valid metadata with the current project path is left
  unchanged; and valid metadata with a different path is replaced atomically
  with mode `0600`. If metadata restored as another user blocks initialization,
  correct its ownership or remove `meta.json`; missing metadata is regenerated
  on the next initialization. Separately, final successful ingest and compact
  timestamp updates use the same size, regular-file, and single-link checks as
  a best-effort write, and require a matching owner when the process user ID is
  available. Malformed, oversized, linked, non-regular, or owner-mismatched
  metadata is left unchanged by those final timestamp updates.
  `lcm import-knowledge` uses a separate create-only path. When metadata is
  missing, it atomically publishes the complete project identity with mode
  `0600` and tightens the project directory to mode `0700`. Existing metadata
  is never replaced by import, including malformed files and dangling symbolic
  links. Import still completes when such an entry is preserved, but malformed
  or dangling metadata is not automatically repaired and may keep the project
  from being discovered by `lcm export --all` until you correct or
  remove that entry.
  Promote authenticates the immediate metadata parent directory before reading
  `meta.json` and retains that admitted directory through parsing and
  publication. A successful bounded read is accepted only when the reader's
  sampled parent device and inode match the admitted directory. Persistent
  directory-entry replacement detected during failure handling or publication
  also fails closed. Promotion database work completed before the metadata
  update is not rolled back. These checks cover the immediate metadata parent
  at their stated samples; they do not reauthenticate the full ancestor chain
  or claim detection of every transient replacement. A missing-file race has no
  sampled parent identity and remains outside this guarantee.
- **`~/.lcm/projects/{hash}/sensitive-patterns.txt`** — Per-project sensitive patterns (if configured).
- **`~/.lcm/config.json`** — Global configuration including the optional `security.sensitivePatterns` array.
- **`~/.lcm/daemon.pid`** — Daemon process ID (transient).

On first startup after upgrading from older releases, lcm automatically migrates an existing legacy runtime directory to `~/.lcm/` when `~/.lcm/` is absent or does not already contain LCM data.

No data is sent to any Long Context Manager (LCM) server. There is no telemetry.
An explicitly configured PostgreSQL backend is a user-operated remote-primary
store; daemon project writes and reads use it only after the publication and
identity gates described below. Hook capture remains local and the data sent to
PostgreSQL is described below.

## What leaves your machine

Long Context Manager (LCM) is a local runtime. By default, **nothing leaves your machine**.

External data flow occurs only through a summarizer or PostgreSQL destination
that you configure explicitly:

| Summarizer (`llm.provider`) | Data sent externally |
|-----------------------------|----------------------|
| `disabled` (default) | Nothing |
| `claude-process` | Messages sent to Anthropic via the `claude` CLI (your Claude subscription) |
| `codex-process` | Messages sent through the Codex CLI and its per-call loopback Responses gateway to the effective Codex `openai_base_url` (or the existing token-class default when absent or `null`) |
| `anthropic` | Messages sent to Anthropic API (your API key) |
| `openai` | Messages sent to OpenAI API (your API key) |

When using an external summarizer, only the text being summarized is sent — not your full history. The summarizer receives a batch of recent messages to compress into a summary.

For `codex-process`, the Codex CLI receives only a fixed, non-sensitive
bootstrap string. The gateway holds the complete LCM summarizer prompt and
transcript in memory for one request, then discards them when the call closes.
It constructs a fresh minimized Responses payload rather than forwarding the
CLI's inherited instructions, input, tool inventory, client metadata, or
prompt-cache key. The payload explicitly uses `tools: []`,
`tool_choice: "none"`, `parallel_tool_calls: false`, `store: false`, and
`stream: true` in the standard Responses dialect. Responses Lite instead uses
an explicit empty `additional_tools` inventory and omits top-level `tools`.
Both dialects discard inherited prompt/input/tools state; `include` and
`stream_options` are omitted. Managed authentication is forwarded only through
an explicit header allowlist, and a configured Codex `openai_base_url` is
authoritative for both bearer classes. When that value is absent or `null`,
`sk-`-prefixed bearer credentials use the public OpenAI route while other
managed bearers use the ChatGPT route, even when account ID is absent. A
configured endpoint may receive the managed bearer, account identifier, and
allowlisted Codex metadata, including over cleartext HTTP; use HTTPS when the
endpoint supports it. Resolution reads the on-disk Codex configuration from
the LCM process's inherited environment and working directory, rather than
from a live parent session profile. It never persists or logs credentials,
raw request bodies, prompts, or upstream response bodies. If authentication,
request shape, routing, streaming, or gateway shutdown is ambiguous, the
compaction fails closed. The selected provider's retention policy still
applies to the minimized request sent outside the machine.

The daemon's PostgreSQL project routes store scrubbed messages, summaries,
promoted memories, and related repository data only after local validation and
redaction. The PostgreSQL native-transcript repository stores only client-native JSON
records that passed local decoding, scrubbing, residual-secret validation, and
canonicalization. For the explicit embedded and backfill APIs, an accepted
sanitized native record must also fit the same inclusive 10 MiB limit in
canonical UTF-8, independently of the raw JSONL byte check. Here, “raw
transcript” means that sanitized native record and its provenance; LCM never
sends the verbatim pre-redaction source record to PostgreSQL. Failed records
produce only bounded metadata in private local quarantine stores separated by
project and transcript client. The client identity exists only in the opaque
database namespace, not in quarantine rows, so identical Claude and Codex
metadata cannot deduplicate across clients.
Native-transcript daemon and CLI routing is not active; explicit backfill and
adapter use are documented in
[PostgreSQL native transcripts](../src/storage/postgresql/reference/postgresql-native-transcripts.md).

## Secret redaction

Long Context Manager (LCM) scrubs secrets from message content **before writing
to the selected project backend (SQLite or PostgreSQL)** and **before sending
to the summarizer**. Redaction happens at both write points to ensure secrets
are never persisted or transmitted in cleartext.

The same redaction boundary applies to passive hook events, promoted memories,
manual-store content and tags, and portable exports/imports. It combines the
bundled Gitleaks rules, built-in patterns, global `security.sensitivePatterns`,
and the project's `sensitive-patterns.txt`. Previously captured passive events
are scrubbed again before promotion.

For PostgreSQL native transcripts, the embedded caller must explicitly
load and pass both effective custom-pattern arrays: global
`security.sensitivePatterns` as `globalPatterns` and the project's
`sensitive-patterns.txt` as `projectPatterns`. The API does not load them
implicitly; missing or non-array values fail before source or repository
access, while an explicit empty array means that scope has no configured custom
rules. LCM applies those arrays plus the bundled rules recursively to every
string key and value. Invalid UTF-8, malformed or scalar JSON, records
oversized in raw JSONL bytes or after scrubbing in canonical UTF-8, U+0000,
invalid custom patterns, redacted-key collisions, residual matches, and JSON
nested beyond the exported depth limit of 100 are rejected locally. Either
size rejection retains only the raw-record digest and bounded reason metadata
in local quarantine; transient scrubbed expansion before rejection is not a
peak-memory guarantee. Integer-valued JSON tokens outside JavaScript's
safe-integer range
are rejected regardless of integer, decimal, or exponent spelling, including
values that happen to round-trip exactly as a `number`. Other numeric spellings
that would lose their exact decimal value, and lone UTF-16 surrogate code units
in string keys or values, are also quarantined locally as `malformed-json`.
Valid safe integers, fractions whose canonical decimal spelling round-trips
unchanged through JavaScript number formatting, surrogate pairs, and literal
Unicode remain supported. No source payload or parser excerpt is written to
quarantine.
Pattern-based filtering still has residual risk: an organization-specific
secret that matches no active rule can remain in the sanitized record. Test
project patterns against representative canaries before backfill and protect
the destination as sensitive conversation data.

Memory restored into an agent prompt is wrapped in a content fence. Closing
fence tags embedded in summaries, learned insights, or prompt-search hints are
escaped so stored text cannot create a sibling instruction block.

### Built-in patterns

These patterns are always active, regardless of configuration:

| Pattern | Example match |
|---------|--------------|
| OpenAI secret key | `sk-...` |
| Anthropic API key | `sk-ant-...` |
| GitHub personal access token | `ghp_...` |
| AWS access key ID | `AKIA...` |
| PEM private key | `-----BEGIN ... KEY-----` |
| Bearer token | `Authorization: Bearer ...` |
| Password assignment | `password=...`, `PASSWORD: ...` |

### Project-specific patterns

Add patterns for secrets specific to your project:

```bash
# Add a pattern (stored in ~/.lcm/projects/{hash}/sensitive-patterns.txt)
lcm sensitive add "MY_APP_API_KEY_[A-Z0-9]+"

# Add a global pattern (applies to all projects, stored in config.json)
lcm sensitive add --global "CORP_INTERNAL_TOKEN"

# Test what gets redacted
lcm sensitive test "token=MY_APP_API_KEY_ABCDEF123"
# → token=[REDACTED]

# List all active patterns
lcm sensitive list
```

Patterns are JavaScript-compatible regular expressions. Use specific patterns (e.g., `MY_SECRET_[A-Z0-9]+`) rather than broad ones (e.g., `MY_.*`) to avoid over-redaction.

Patterns that produce a zero-width match still remove source text: lcm expands the match to the complete non-whitespace token at the match boundary. If the boundary is not adjacent to a token, lcm redacts the next token; when no following token exists, such as after the final token in trailing whitespace, it falls back to that final preceding token. If mixed assertions make both adjacent tokens plausible, lcm redacts both rather than risk exposing the sensitive value. Use a consuming pattern when you need more precise control over the redacted range. A zero-width match against text containing no non-whitespace token is ignored rather than reported as a redaction.

When filtering occurs, session-end hooks warn that sensitive data was removed and identify the matching categories. Older or malformed ingest responses that omit category metadata are reported as `unknown`; the warning never displays an empty category.

Custom patterns are safety-checked before use. Invalid expressions and patterns that can trigger catastrophic backtracking are rejected by `lcm sensitive test`, doctor checks, search, promotion detection, and redaction. Built-in redaction patterns are maintained by lcm and are not affected by this custom-pattern guard.

## Data retention

Messages and summaries persist until you explicitly remove them:

```bash
# Remove data for the current project
lcm sensitive purge --yes

# Remove all Long Context Manager (LCM) data
lcm uninstall
```

SQLite-selected project database files are stored in `~/.lcm/projects/`.
PostgreSQL-selected project data is retained by the configured PostgreSQL
operator; changing selection does not copy it into SQLite. You can delete
individual local project directories manually to remove local history.

These local commands do not delete PostgreSQL data. Native transcript rows are
append-only and the issue #86 repository exposes no deletion operation.
Database retention, encrypted backup retention, and any future administrative
erasure workflow remain the PostgreSQL operator's responsibility. Disabling or
rolling back a backfill stops new writes without rewriting the source or
deleting already committed sanitized rows.

## Verifying your setup

```bash
lcm doctor
```

The `Security` section of the doctor output shows:
- How many built-in patterns are active
- Whether project-specific patterns are configured

## Safe local diagnostics

- The `/describe` and `/expand` compatibility handlers sanitize fallback error
  messages before handing them to the daemon response layer, which sanitizes
  top-level error strings again before serialization. They retain their legacy
  HTTP `200` status and null-result response shape. SQLite details become a
  `database constraint error`. Host-local POSIX, Windows, and UNC paths become
  `<path>`; quoted paths may contain spaces, while unquoted paths stop at
  whitespace so arbitrary trailing prose remains intact. File URLs preserve
  their scheme and authority spelling while replacing a non-root path after
  the authority with `<path>`, including an initial Windows drive. A quote
  immediately before the `file` scheme lets the redacted path contain spaces
  until the matching quote or a newline. Empty and root-only file URLs remain
  unchanged. Unmatched or path-wrapping brackets in file URLs do not stop path
  redaction; valid bracketed IPv6 authorities, including zone IDs, remain
  intact. When a closing path-wrapping bracket is immediately followed by a
  slash or backslash path segment, that adjacent segment is also redacted in
  the same pass. In unquoted file URLs, whitespace and the existing path
  delimiters, including later colons, `?`, and `#`, end the redacted span, so
  text after those delimiters can remain visible. Before the first path
  separator, semicolons, commas, apostrophes, closing parentheses, and closing
  braces remain part of an exact `file://` authority. In a single-quoted exact
  file URL, that includes an apostrophe matching the quote before the scheme;
  it closes the current URL only when immediately followed by a fresh,
  case-insensitive `file://` literal. That literal begins a separately quoted
  nested file URL, preserving redaction of its path when the path contains
  spaces. Otherwise, the matching apostrophe remains authority text. Before
  the first path separator, an apostrophe inside an unquoted or double-quoted
  authority, or a double quote inside an unquoted or apostrophe-quoted
  authority, also remains conservatively classified as authority text so a
  following local path is redacted. A matching double quote still closes a
  double-quoted file URL. The existing outer-quoted query and fragment markers,
  `?` and `#`, keep exact-file classification before the first path. Pre-path
  whitespace resets classification. The remaining URL-ending punctuation
  (`|`, `<`, `>`, and closing square brackets subject to the existing bracket
  handling) ends it. After a path begins, these characters retain their
  existing path and prose delimiter behavior, and a matching quote closes the
  redacted path. A quoted path can contain spaces; redaction continues to that
  matching quote, a newline, or EOF. Empty and root-only file URLs remain
  unchanged. Unspaced text after an apparent pathless closing apostrophe can be
  treated as continuing authority text, so an eventual path can cause
  conservative redaction of that later text. Whitespace-separated following
  prose or URLs are classified normally. Double quotes in non-file URLs or
  structured text and ordinary quoted local paths retain their existing
  boundaries. Ordinary HTTP and HTTPS URLs retain their authorities, slashes,
  and paths. In an unquoted exact
  `file://` URL with no path, a `?` or `#` outside still-open brackets ends the
  file URL authority classification. Following text is classified from fresh
  state: a nested non-file URL remains intact, while standalone POSIX, Windows,
  and UNC paths retain redaction. The first backslash-based path also remains
  redacted across forward slashes and file-authority punctuation (semicolons,
  commas, apostrophes, closing parentheses, and closing braces). Whitespace, a
  freshly recognized URL, or other URL-ending punctuation ends that context. A
  recognizable nested exact `file://` path is also redacted. An exact
  case-insensitive `file://` literal immediately after `?`, `#`, `&`, or `=`
  inside any URL starts a nested file URL. Once an outer URL has entered its
  query or fragment, the same literal also starts a nested file URL after any
  character other than an ASCII letter, including query value wrappers,
  punctuation, and digits. ASCII-letter-glued names such as `profile://` and
  `xfile://` remain ordinary URL text. LCM preserves the outer URL and replaces
  only the nested file path. This bounded rule does not decode percent-encoded
  schemes or recognize `file://` text in an ordinary URL path. Outer-quoted
  pathless file URLs retain their conservative file-path classification through
  `?` and `#`, so a nested non-file URL in that quoted span may still be
  redacted as a path. There are no configuration options for this
  defense-in-depth behavior.
- Hook project paths retain leading and trailing whitespace. Directories whose names differ only by that whitespace remain separate LCM projects.
- Hook errors are attached to a project sidecar only when the reported working directory is an existing directory. Invalid paths are recorded in the bounded fallback log without creating project metadata.
- `lcm stats` and verbose `lcm doctor` remove terminal control sequences and line breaks from persisted text before displaying it. SQLite content is not modified by display sanitization.
- Sidecar scans return a single aggregate truncation record when their time or database limit is reached, so diagnostic responses remain bounded even if the events directory contains many files.

## Summary

- SQLite remains the default and keeps data in `~/.lcm/`.
- An explicitly configured PostgreSQL destination receives only data admitted
  by its repository; daemon messages and native transcripts are scrubbed and
  validated locally first. Native-transcript daemon routing remains inactive.
- External summarizer (optional) receives only the text to be summarized, after scrubbing.
- Built-in patterns redact common secret formats automatically.
- Add project-specific patterns with `lcm sensitive add`.
- Delete your data with `lcm uninstall` or by removing `~/.lcm/`.
