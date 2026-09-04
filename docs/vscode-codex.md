# VS Code and Codex setup

This repository has the shared memory backend needed for VS Code and Codex.
Codex supports complete CLI or MCP connector bundles; GitHub Copilot in VS Code
uses the CLI guidance bundle.

For normal use, install and update the published package through npm:

```bash
npm install -g @donadiosolutions/lcm@latest
```

Claude Code uses the same npm package. Run `lcm install` for its native hooks,
MCP server, commands, and skills; direct Claude Marketplace installation is no
longer supported.

## Install from a repo checkout

If you are working from this repository directly instead of the published npm package:

```bash
npm install
npm run build
npm link
```

If you do not want a global link, run `node dist/lcm.mjs ...` instead of
`lcm ...` in the commands below.

## Install the VS Code connector

For GitHub Copilot in VS Code:

```bash
lcm connectors install github-copilot --transport cli
lcm connectors doctor github-copilot
```

This writes a repo-local skill file at `.github/skills/lcm-memory/SKILL.md`.

Rules connectors append one managed Markdown block to the target document. The
installer keeps the document byte-consistent when it reinstalls that block: it
uses CRLF when the retained document or generated block uses CRLF, otherwise
LF, normalizes the separator and generated block to that style, and emits one
final line break. Markdown-significant trailing spaces and tabs are preserved.

## Install the Codex connector

For Codex in the current repository:

```bash
lcm connectors install codex
lcm connectors doctor codex
```

This writes the default Codex CLI bundle:

- `~/.codex/hooks.json`
- `~/.codex/config.toml` with `[features].hooks = true`
- `.codex/skills/lcm-memory/SKILL.md`
- `~/.codex/AGENTS.md` with one minimal managed memory-retrieval rule

The `AGENTS.md` entry requires Codex to use the `lcm-memory` skill before
starting substantive work or when it needs further project understanding. The
skill remains the detailed operational guidance, while passive hook injection
can satisfy routine context recovery without another explicit search. Existing
user content is preserved with one blank line before the managed entry. A fresh
or default Codex CLI install does not add, remove, or inspect MCP configuration.

Connector installation selects one complete transport bundle:

```bash
lcm connectors install <agent> [--transport cli|mcp] [--global]
lcm connectors remove <agent> [--global]
```

The precedence order is explicit `--transport`, then stored
`connectors.transports.<agent-id>`, then the registry default; implicit defaults
are not persisted. Claude Code, Qwen Code, and Zed default to MCP. Codex and
every other agent default to CLI. Cline and Augment are CLI-only until
verifiable MCP adapters exist. Guidance never falls back between transports,
and removal removes the whole LCM-owned bundle.

To opt Codex into MCP, use:

```bash
lcm connectors install codex --transport mcp
lcm connectors doctor codex
```

The Codex MCP connector treats an absent `lcm` registration as absent only for
a positive safe-integer exit status and either exact
`codex mcp get lcm --json` diagnostic:
`No MCP server named 'lcm' found.` and
`Error: No MCP server named 'lcm' found.`. The latter is the diagnostic emitted
by Codex 0.147.0. The connector trims the diagnostic before this exact match,
but otherwise fails closed: a zero or negative exit status, a non-integer status, a
different server name, extra output, or any other near-match is reported as an
unavailable/error state rather than being treated as an absent registration.
If native inspection is unavailable, connector doctor reads the stored Codex
transport through a bounded, stable configuration snapshot without taking the
publication mutation lock.

The MCP bundle uses native `codex mcp` commands for Codex registration and
requires no TOML editing. Use
`lcm connectors install codex --transport cli` to converge back to the CLI
bundle. The MCP bundle does not retain or install the CLI-only managed
`~/.codex/AGENTS.md` entry. Explicit or stored CLI convergence may remove only
the exact LCM-owned MCP registration.

On Linux, LCM forwards the user-session bus to those nested commands only as
the exact validated pair `XDG_RUNTIME_DIR=/run/user/<uid>` and
`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`. The runtime directory
must be canonical, user-owned, and mode `0700`; the matching endpoint must be
a canonical user-owned socket. LCM omits both values if either side is missing,
malformed, oversized, redirected, foreign-owned, non-socket, or mismatched,
and it does not inherit unrelated process environment variables.

The hook connector installs these Codex events:

| Event | Command | Behavior |
|---|---|---|
| `SessionStart` | `lcm restore --client codex` | Restores project context when Codex starts, resumes, or clears a session |
| `UserPromptSubmit` | `lcm user-prompt --client codex` | Searches memory and injects prompt-time hints |
| `PostToolUse` | `lcm post-tool --client codex` | Captures bounded semantic signals from `functions.exec` and `functions.exec_command` |
| `PreCompact` | `lcm session-snapshot --client codex` | Force-ingests transcript deltas before manual or automatic Codex compaction |
| `Stop` | `lcm session-snapshot --client codex` | Ingests transcript deltas and triggers compaction once the configured token threshold is reached |

Codex must trust the project `.codex/` layer for project-local hooks to load. For a global setup, run:

```bash
lcm connectors install codex --global
lcm connectors doctor codex --global
```

### Codex PostToolUse capture boundary

The installed PostToolUse hook must be an exact command hook under a `*`
matcher:

```json
{
  "matcher": "*",
  "hooks": [
    { "type": "command", "command": "lcm post-tool --client codex" }
  ]
}
```

`lcm connectors doctor codex` (or the same command with `--global`) verifies
that structure in the canonical Codex hook file. It then runs a pure,
no-write functional check over representative native payloads. The check does
not run the hook handler, write hook files, create an event database, open an
EventsDb, or append sidecar events. If the structure is absent or incomplete,
doctor prints `Codex: native exec capture functional check skipped` and does
not claim functional health.

Codex capture is deliberately narrow. Only `client: "codex"` payloads with
`tool_name` equal to `functions.exec` or `functions.exec_command` are adapted.
The adapter takes `tool_input.command`, or `tool_input.cmd` when `command` is
absent, and bounds the accepted command to 2,000 characters before passing it
through the existing event-data truncation and sensitive-data scrubbing. It
projects only direct status fields from `tool_output` (preferred) or
`tool_response`, using `isError`, `is_error`, `exit_code`, and `exitCode` in
that order. Raw stdout/stderr, raw responses, nested or unknown output fields,
and file-like fields are not persisted or interpreted as file events. A
trimmed command beginning with `lcm store` is suppressed to avoid a feedback
loop from LCM's own storage calls. There is no new configuration option for
these fixed capture rules.

Because this hook runs after every tool call, its CLI entrypoint does not run
legacy-root bootstrap migration before reading and dispatching the payload.
LCM installation and session startup establish or migrate the private root;
PostToolUse remains an observer and cannot contend on that startup boundary.

If selected-state publication admission is blocked after a PostToolUse event
has been durably appended, the event remains preserved locally. Missing
publication evidence and typed private lock contention are successful
best-effort hook outcomes and do not add a hook-error ledger entry. Other
malformed, tampered, unsafe, mismatched, or
unresolved evidence fails closed for selected-state work and surfaces this exact
fixed diagnostic. After the event is durable, the PostToolUse hook returns code
`0` with a JSON `systemMessage` containing that same line, so Codex can render
actionable feedback without treating the observer process as failed. A direct
invocation that fails before durable enqueue retains the fixed stderr diagnostic
and exit code `1`. Selected-state work remains refused:

```text
lcm: backend publication admission blocked; preserve the evidence, run 'lcm doctor', and resolve the authenticated publication before retrying.
```

The diagnostic never includes the raw publication error, cause, stack, path,
URL, credential, or journal contents. Follow the preserve-evidence, `lcm
doctor`, and owning-publication-recovery sequence in
[`backend-publication.md`](backend-publication.md) before retrying Codex.

Reinstalling generated Markdown connectors is byte-idempotent: the Codex skill
`.codex/skills/lcm-memory/SKILL.md` remains byte-identical to its canonical
template with exactly one final newline. The skill and explicit rules fallback
share one catalog of operation names, purposes, lifecycle triggers, and CLI/MCP
spellings. Their lean workflow uses automatically injected memory first,
requires immediate explicit storage of every newly recognized durable learning
with its rationale, and treats automatic capture as complementary rather than a
substitute. Normal rules append installs remove and reappend their managed block
without changing the established LF or CRLF style. One-run healing is limited to
recognized current or legacy managed
blocks, the maximal union of their overlapping or touching recognized ranges,
and a current marker followed only by one or more exact `# Workflow Instruction`
lines as a recoverable header-only partial region. These recognized regions are
replaced with one canonical block in the established style. Arbitrary
ambiguous or malformed unmatched marker/header combinations are preserved
conservatively and may require a second reinstall to become byte-stable; user-
authored Markdown outside recognized regions, including heading lines, is never
removed by this recovery behavior.

Removing a rules connector deletes its file only when managed-block removal
leaves zero bytes. Spaces, tabs, form-feed, and other non-CR/LF user Markdown
bytes are preserved and written with exactly one established terminal EOL;
content consisting only of blank lines is deleted.

To import existing Codex sessions into LCM:

```bash
lcm import --codex
lcm import --provider all
```

## Current limitations

1. GitHub Copilot in VS Code is skill-based today. There is no automatic session restore, turn ingestion, prompt-time search injection, or compaction hook.
2. The GitHub Copilot connector does not register MCP automatically. The current supported path is instructions/skill guidance plus the `lcm` CLI.
3. Codex MCP is opt-in. The explicit MCP bundle uses native `codex mcp`
   commands; default/fresh Codex CLI installation remains hook+skill+minimal
   rules and does not inspect MCP.
4. Codex `Stop` hooks are turn-scoped, not final-session hooks. LCM therefore uses rolling snapshots and thresholded compaction instead of marking Codex sessions complete on each `Stop`; the `PreCompact` snapshot hook fills the pre-compaction gap.
5. Claude Code and Codex use native integrations, but their setup commands remain different.

## Improvement candidates

1. Add first-class `lcm setup vscode` and `lcm setup codex` commands instead of overloading `lcm install`.
2. Extend native Codex MCP adapter coverage only after each adapter is verifiable; Cline and Augment remain CLI-only until then.
3. Add a real VS Code runtime adapter for restore, writeback, and prompt-time recall instead of skill-only guidance.
4. Connector diagnostics now validate the exact Codex PostToolUse structure and
   its pure native-exec capture path; no database or hook-file writes are part
   of the check.
