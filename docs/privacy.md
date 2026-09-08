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
  with mode `0600`. The serialized UTF-8 representation, including indentation
  and its terminating newline, must also fit within 1 MiB. If publication would
  exceed that limit, LCM reports `project metadata exceeds size limit` before
  writing and preserves an existing `meta.json` unchanged.

  To recover, inspect `~/.lcm/projects/{hash}/meta.json` and reduce optional
  metadata until the serialized file fits. You can instead back up and remove
  only `meta.json` so LCM regenerates it on the next initialization; the project
  history in `db.sqlite` is preserved. If metadata restored as another user
  blocks initialization, correct its ownership or use the same metadata-only
  recovery. Separately, final successful ingest and compact
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
  Promote opens the snapshotted LCM root, `projects` directory, and project
  directory separately before reading `meta.json`. It retains and reasserts all
  three directory entries through parsing and publication. A successful bounded
  read is accepted only when the reader's sampled parent device and inode match
  the retained project directory. A symlink visible during chain acquisition,
  or persistent directory-entry replacement detected at a later sample, fails
  closed. Promotion database work and a metadata update completed before a
  post-publication failure are not rolled back. The guarantee begins when the
  metadata phase acquires this chain, so an independently valid private
  hierarchy substituted before that phase can be admitted. When promotion
  retains the metadata parent, the atomic writer reasserts that parent after
  creating its temporary file, before writing content, and again immediately
  before rename or exclusive link. It also requires the temporary pathname to
  still identify the regular file it created. Observed drift at either point
  refuses publication. These checks are bounded observations rather than an
  atomic pin on the parent pathname: they do not detect every transient
  replacement or prevent a change during publication. If rename or link returns
  and the following parent check fails, the error outcome is `published`; this
  means the operation completed, not that it reached the retained directory. If
  rename or a non-collision link attempt throws and the parent check also fails,
  the outcome is `unknown`. Either outcome means bytes may have been published
  and must not authorize automatic rollback or retry.

  When `meta.json` is missing, promotion creates it only if the retained project
  directory still has no destination entry at publication. A restored file or
  concurrent creation is refused with the existing topology error and is not
  overwritten. This portable create briefly links the complete private file at
  both its temporary and final names; a concurrent bounded reader can fail
  closed during that interval. The earlier missing-file observation is not
  proof of historical absence. Calls without a retained parent and the bounded
  pathname windows described above remain outside the guarantee; these checks
  do not provide descriptor-relative pathname mutation.

  A post-link cleanup or single-link verification failure reports
  `private file link completed, but published file topology is not trusted`.
  The completed `meta.json` can remain linked to a hidden
  `.meta.json.*.tmp` name, with link count two, and later metadata admission
  will refuse it. Before retrying, inspect both entries with an inode-reporting
  tool such as `ls -li`. If they have the same inode and the expected owner,
  mode, and content, remove only the hidden temporary name, then verify that
  `meta.json` has link count one and mode `0600`. If those identities do not
  match, preserve both entries and investigate rather than deleting either one.
- **`~/.lcm/projects/{hash}/sensitive-patterns.txt`** — Per-project sensitive patterns (if configured).
- **`~/.lcm/config.json`** — Global configuration including the optional `security.sensitivePatterns` array.
- **`~/.lcm/daemon.pid`** — Daemon process ID (transient).

On first startup after upgrading from older releases, lcm automatically migrates an existing legacy runtime directory to `~/.lcm/` when `~/.lcm/` is absent or does not already contain LCM data.

### Embedded NUL in promoted memory

SQLite promoted-memory content must be ordinary SQLite `TEXT` without an
embedded NUL character (`U+0000`). The Node SQLite binding can return only the
prefix of a scalar value when a legacy row contains that byte. The promoted
memory store refuses to publish, search, list, export, recall, or replay these
selected values into its FTS index.
The refusal uses a fixed error and does not include the memory text, ID, path,
or query. NUL characters in JSON-escaped tags remain supported.

New promoted content containing `U+0000` is rejected before the database write.
For a legacy row, use the offline procedure below with **Node.js 24 or newer**
(the built-in `node:sqlite` module supplies everything; no npm dependencies or
LCM internal imports are needed). LCM does not strip bytes, truncate rows, or
run an automatic migration. If no intended replacement is known, preserve the
backup and leave the row refused.

1. Close agent sessions and stop the LCM service with your service manager.
   Keep all writers, including hooks, CLI commands and worktree reconciliation,
   stopped throughout maintenance. Identify the project's existing
   `~/.lcm/projects/{hash}/db.sqlite` using its adjacent `meta.json`; use the
   configured runtime directory if yours differs. This procedure is only for
   SQLite projects.
2. In a private directory (`umask 077` on POSIX), save the following script as
   `repair-promoted.mjs`. First run `node repair-promoted.mjs /absolute/path/db.sqlite`
   to print affected IDs only. It opens the database read-only and does not
   print memory content.
3. Put the complete intended replacement in a private UTF-8 text file. Every
   byte, including a final newline, is part of the replacement. Run the repair
   with the selected ID, replacement file and a **new backup filename**:

   ```sh
   node repair-promoted.mjs /absolute/path/db.sqlite SELECTED_ID /absolute/path/replacement.txt /absolute/path/before-repair.sqlite
   ```

   The script creates a consistent SQLite backup (including committed WAL
   data), verifies its integrity, then replaces that row and its FTS entry in
   one transaction. It preserves all other fields, and keeps archived rows out
   of the search index. It refuses healthy rows, unknown IDs, invalid UTF-8 and
   NUL-containing replacements. A failed repair rolls back; keep the backup.

```js
import { DatabaseSync, backup } from "node:sqlite";
import { closeSync, openSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length !== 1 && args.length !== 4) {
  throw new Error("Usage: node repair-promoted.mjs DB [ID TEXT_FILE NEW_BACKUP]");
}
const [path, id, textFile, backupPath] = args;
if (!statSync(path).isFile()) throw new Error("DB must be an existing file");
const unsupported = "typeof(content) <> 'text' OR instr(content, char(0)) > 0";
const db = new DatabaseSync(path, { readOnly: args.length === 1 });
try {
  if (args.length === 1) {
    for (const row of db.prepare(`SELECT id FROM promoted WHERE ${unsupported}`).all()) {
      console.log(JSON.stringify(row.id));
    }
  } else {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(readFileSync(textFile));
    if (content.includes("\u0000")) throw new Error("Replacement contains NUL");
    // Exclusive creation prevents overwriting an existing backup or the DB.
    closeSync(openSync(backupPath, "wx", 0o600));
    await backup(db, backupPath);
    const saved = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const checks = saved.prepare("PRAGMA integrity_check").all();
      if (checks.length !== 1 || checks[0].integrity_check !== "ok") {
        throw new Error("Backup integrity check failed");
      }
    } finally {
      saved.close();
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT rowid, tags, archived_at FROM promoted
        WHERE id = ? AND (${unsupported})`).get(id);
      if (!row) throw new Error("ID is missing or does not need repair");
      db.prepare("UPDATE promoted SET content = ? WHERE id = ?").run(content, id);
      const fts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'promoted_fts'").get();
      if (fts) {
        db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
        if (row.archived_at === null) {
          db.prepare("INSERT INTO promoted_fts(rowid, content, tags) VALUES (?, ?, ?)")
            .run(row.rowid, content, row.tags);
        }
      }
      db.exec("COMMIT");
      console.log("Repair committed; retain the verified backup.");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
} finally {
  db.close();
}
```

4. Repeat the diagnostic until no affected IDs remain (use a new backup name
   for each repair). Restart the service and agent sessions, then verify the
   active memory with `lcm search "distinctive replacement words"` from the
   original project directory before resuming normal use. Archived memories
   remain excluded from search; the offline diagnostic verifies that their
   content is now supported. Retain the backup until verification is complete.
   Do not replace a live
   database file or discard its WAL/SHM sidecars to restore a backup; stop all
   writers again before any restoration.

Legacy worktree reconciliation uses a separate import path. During a real
reconciliation, LCM checks the live source database while its existing
exclusive write lock is held and checks the canonical target inside its target
transaction. For a source that has not been merged, a promoted row whose
`content` is not SQLite `TEXT` or contains an embedded NUL fails closed with
`stored promoted content is unsupported` before the row can be copied or used
to rebuild FTS. The source check rolls back the uncommitted fence, so the source
bytes remain intact and can be repaired in place. A target check rolls back the
target transaction; its source fence may already be committed, so repair the
target database in place and rerun reconciliation. Use the offline diagnostic
and replacement procedure above to inspect and deliberately repair affected
rows before retrying.

A canonical per-source completion marker remains an idempotent recovery
boundary. LCM does not ask for a source repair that the completed merge would
skip; it re-fences and archives that source, preserving its original bytes in
the private backup. If the completion marker is missing when the target
transaction checks it, LCM rechecks the normalized source and fails closed
instead of relying on the earlier marker observation. This does not audit or
repair canonical content written by an older LCM version. If that target
contains a known truncated legacy value, repair the canonical target with the
offline procedure above. This refusal
behavior is implemented by [#1173](https://github.com/donadiosolutions/lcm/issues/1173).

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
For the exact `gpt-5.3-codex-spark` model, the gateway removes the Lite marker
and always emits the standard payload with top-level `tools: []`; it retains
only a validated reasoning `effort`. Other models preserve Codex's selected
dialect. Both dialects discard inherited prompt/input/tools state; `include`
and `stream_options` are omitted. Managed authentication is forwarded only
through an explicit header allowlist, and a configured Codex `openai_base_url` is
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

For an upstream HTTP 400, the gateway may inspect at most 64 KiB of response
body to recognize one exact structured Spark protocol rejection. It does not
render, log, persist, or relay those bytes. Malformed, oversized, interrupted,
or unknown responses receive a fixed generic upstream category, and the body
stream is canceled. Other upstream status bodies are not parsed for protocol
classification.

The daemon's PostgreSQL project routes store scrubbed messages, summaries,
promoted memories, and related repository data only after local validation and
redaction. Both SQLite and PostgreSQL native-transcript repositories store only client-native JSON
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
`lcm import` and transcript-path daemon ingestion run this native backfill
after storing parsed messages. Native failure fails the import; retry resumes
native checkpoints even if the parsed messages already exist. Structured
`messages` requests retain their existing parsed-message behavior. Details are in
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

The bundled Slack webhook (`hooks.slack.com`) and Sidekiq
(`gems.contribsys.com` and `enterprise.contribsys.com`) service-hostname rules
match their hostnames case-insensitively while treating dots literally. The
Slack webhook rule still accepts only the lowercase `/services`, `/workflows`,
and `/triggers` path prefixes and preserves its token-suffix boundaries. A
lookalike hostname is not treated or redacted as that service; add a custom
pattern when your environment intentionally uses one. Other bundled hostname
rules retain their own matching behavior.

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

Project pattern commands require `sensitive-patterns.txt` to be a regular,
single-link file owned by the current user. A validation failure exits nonzero
without changing the project path or any external hard link to the same inode;
correct the file type, ownership, or link topology before retrying. On platforms
that do not expose an effective user ID, only the ownership check is skipped.

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
  whitespace so arbitrary trailing prose remains intact. Inside an already
  recognized path, a drive-shaped doubled-colon segment ending in a backslash
  is also redacted, including in slash-prefixed Windows drives. A URL-shaped
  scheme token immediately after that backslash retains the existing URL
  boundary behavior. This does not
  make doubled-colon text a new path start: standalone `E::\` tails, longer
  colon runs, and non-drive-shaped segments remain unchanged. File URLs
  preserve their scheme and authority spelling while replacing a non-root path
  after the authority with `<path>`, including an initial Windows drive. A quote
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
  redacted path, even inside unmatched or path-wrapping brackets. The matching
  quote also stops that file URL from hiding a later standalone local path,
  which is redacted in the same pass. A backslash path immediately after that
  quote is also redacted when the surrounding bracket remains unmatched:
  `'file://host'['/private'\Users\SECRET` becomes
  `'file://host'['<path>'<path>`. This immediate-backslash handoff also applies
  when a matching quote closes a root-only file path outside brackets: the root
  separators remain unchanged and the following Windows path becomes `<path>`.
  While an exact file URL's context remains
  active, a backslash path in that URL's own query or fragment is redacted on
  the first pass. This includes a query or fragment following a closed quoted
  path, with or without a closing wrapper. Whitespace and URL-ending delimiters
  can end that context; this does not extend backslash redaction to unrelated
  text. When non-delimiter query or fragment text follows a quoted path in a
  closed wrapper, a later slash-prefixed local path is redacted in the same
  pass. For example, `'file://host'['/private']?next/Users/SECRET` becomes
  `'file://host'['<path>']?next<path>`. The handoff remains within that exact
  file URL context; whitespace and URL-ending punctuation reset it, and a
  recognized `scheme://` token is not consumed as the local path.
  Classification state from an earlier quoted file URL does not carry into a
  later unquoted file URL's query tail. A public URL glued directly after the
  closing quote or bracket without whitespace may be conservatively redacted:
  `'file://host'['/private']https://pub.test/x` becomes
  `'file://host'['<path>']https:<path>`. If that glued URL is followed by a
  Windows drive path, the URL and drive path are redacted separately, as in
  `https:<path>\<path>`. Conservative redaction can also extend through unspaced
  query-tail continuations. Separating the following public URL with whitespace
  preserves it byte-for-byte. Unspaced text after an apparent pathless closing
  apostrophe can be treated as continuing authority text, so an eventual path
  can cause conservative redaction of that later text. Whitespace-separated
  following prose or URLs are classified normally. Double quotes in non-file
  URLs or structured text and ordinary quoted local paths retain their existing
  boundaries. Ordinary HTTP and HTTPS URLs retain their authorities, slashes,
  and paths. In an unquoted exact
  `file://` URL with no path, a `?` or `#` outside still-open brackets ends the
  file URL authority classification. Following text is classified from fresh
  state: a nested non-file URL remains intact, while standalone POSIX, Windows,
  and UNC paths retain redaction. The first backslash-based path also remains
  redacted across forward slashes and file-authority punctuation (semicolons,
  commas, apostrophes, closing parentheses, and closing braces). Brackets in
  this restarted tail are tracked independently. A slash inside a still-open
  bracket is conservatively treated as a path marker even when it follows a
  word character, and a matched closing bracket keeps the context active so a
  later backslash-based path is also redacted. Once the brackets are balanced,
  ordinary word-adjacent slash text remains unchanged. Whitespace, an unmatched
  closing bracket, a freshly recognized URL, or other URL-ending punctuation
  ends the context and clears its bracket state. A recognizable nested exact
  `file://` path is also redacted. An exact
  case-insensitive `file://` literal immediately after `?`, `#`, `&`, or `=`
  inside any URL starts a nested file URL. Once an outer URL has entered its
  query or fragment, the same literal also starts a nested file URL after any
  character other than an ASCII letter, including query value wrappers,
  punctuation, and digits. At top level and in fresh query or fragment state,
  ASCII-letter-glued names such as `profile://` and `xfile://` remain ordinary
  URL text. Once an unquoted absolute path has started, an adjacent token whose
  suffix is the exact case-insensitive `file://` spelling is conservatively
  absorbed into the same redacted span. Its authority, including optional
  userinfo, port, or bracketed host, and its following path are removed. This
  can remove a non-secret host or port glued to a private path, preventing the
  private tail from remaining visible after one sanitization pass. Ordinary
  unquoted paths also absorb a glued single-slash `file:/` suffix and its
  colon-bearing path segments into the same span. This scan-local rule does not
  make `file:/` a new top-level path start or change ordinary public URL
  classification. Existing
  authority delimiters still end the absorbed span; later word-glued text is
  classified independently and can remain visible even when it resembles a
  local path. An opening `(` instead resumes the already active path scan, so
  its following text remains in the redacted span. LCM preserves the outer URL
  and replaces only the nested file path. When
  recognized nested `file://` literals are adjacent within an outer URL query
  or fragment, each unquoted literal ends the preceding redacted path and keeps
  its complete scheme for independent redaction. A quoted path still consumes
  a nested scheme through its matching closing quote. This bounded rule does
  not decode percent-encoded schemes or
  recognize `file://` text in an ordinary URL path. Outer-quoted pathless file
  URLs retain their conservative file-path classification through `?` and `#`,
  so a nested non-file URL in that quoted span may still be redacted as a path.
  There are no configuration options for this defense-in-depth behavior.
- Hook project paths retain leading and trailing whitespace. Directories whose names differ only by that whitespace remain separate LCM projects.
- Hook errors are attached to a project sidecar only when the reported working directory is an existing directory. Invalid paths are recorded in the bounded fallback log without creating project metadata.
- Stats, status, pool diagnostics, and doctor use an allowlisted backend snapshot. They omit recalled-text previews (`topRecalled`), memory and transcript payloads, raw errors, SQL values, URLs, role names, CA paths, and arbitrary local paths. Verbose diagnostics retain the same boundary. Only observed numeric aggregates, safe identifiers, classified states, and fixed guidance are exposed. SQLite content is not modified; necessary WAL/SHM read coordination may occur. See [observational diagnostics](cli.md#observational-diagnostics).
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
