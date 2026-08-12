# VS Code and Codex setup

This repository has the shared memory backend needed for VS Code and Codex. Codex now has native hooks plus skill and rules connectors; GitHub Copilot in VS Code remains rules based.

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
lcm connectors install github-copilot
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

This writes the default Codex connector set:

- `~/.codex/hooks.json`
- `~/.codex/config.toml` with `[features].hooks = true`
- `.codex/skills/lcm-memory/SKILL.md`
- `~/.codex/AGENTS.md`

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

If you only want the Codex skill or rules instead of the default set:

```bash
lcm connectors install codex --type skill
lcm connectors install codex --type rules
```

Reinstalling generated Markdown connectors is byte-idempotent: the Codex skill
`.codex/skills/lcm-memory/SKILL.md` remains byte-identical to its canonical
template with exactly one final newline, and normal rules append installs remove
and reappend their managed block without changing the established LF or CRLF
style. One-run healing is limited to recognized current or legacy managed
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

## Current shortcomings

1. `lcm install` configures Claude Code's npm-owned native integration. Use `lcm connectors install codex` for Codex and `lcm connectors install github-copilot` for VS Code.
2. GitHub Copilot in VS Code is skill-based today. There is no automatic session restore, turn ingestion, prompt-time search injection, or compaction hook.
3. The GitHub Copilot connector does not register MCP automatically. The current supported path is instructions/skill guidance plus the `lcm` CLI.
4. Codex MCP config lives in `.codex/config.toml`, but the connector installer does not edit TOML yet. `lcm connectors install codex --type mcp` only prints manual instructions.
5. Codex `Stop` hooks are turn-scoped, not final-session hooks. LCM therefore uses rolling snapshots and thresholded compaction instead of marking Codex sessions complete on each `Stop`; the `PreCompact` snapshot hook fills the pre-compaction gap.
6. Claude Code and Codex use native integrations, but their setup commands remain different.

## Improvement candidates

1. Add first-class `lcm setup vscode` and `lcm setup codex` commands instead of overloading `lcm install`.
2. Add TOML read/write support so Codex MCP setup can be automated.
3. Add a real VS Code runtime adapter for restore, writeback, and prompt-time recall instead of rules-only guidance.
4. Connector diagnostics now validate the exact Codex PostToolUse structure and
   its pure native-exec capture path; no database or hook-file writes are part
   of the check.
