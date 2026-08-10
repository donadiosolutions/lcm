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
| `PostToolUse` | `lcm post-tool --client codex` | Captures passive learning signals from supported tool calls |
| `PreCompact` | `lcm session-snapshot --client codex` | Force-ingests transcript deltas before manual or automatic Codex compaction |
| `Stop` | `lcm session-snapshot --client codex` | Ingests transcript deltas and triggers compaction once the configured token threshold is reached |

Codex must trust the project `.codex/` layer for project-local hooks to load. For a global setup, run:

```bash
lcm connectors install codex --global
lcm connectors doctor codex --global
```

If you only want the Codex skill or rules instead of the default set:

```bash
lcm connectors install codex --type skill
lcm connectors install codex --type rules
```

Reinstalling generated Markdown connectors is byte-idempotent: the Codex skill
`.codex/skills/lcm-memory/SKILL.md` remains byte-identical to its canonical
template with exactly one final newline, and rules connectors remove and
reappend their managed block without changing the established LF or CRLF style.
Rules installs also tolerate unmatched standalone `<!-- lcm -->` lines: they
preserve user-authored and inline comment text while keeping the generated
managed block at one copy across repeated installs. A current marker followed
only by one or more workflow-instruction header lines is treated as a
recoverable partial generated block, but other unmatched marker lines remain
untouched. If a target contains duplicate generated blocks, including a mix of
current and legacy marker pairs, reinstalling removes every recognized block
and unions any overlapping or touching recognized ranges before writing one
canonical block in the established LF or CRLF style. Ambiguous nested marker
lines and unmatched markers outside those recognized ranges remain untouched.

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
4. Expand connector diagnostics to validate Codex hook event coverage.
