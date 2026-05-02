# VS Code and Codex setup

This repository has the shared memory backend needed for VS Code and Codex. Codex now has a native hook connector; GitHub Copilot in VS Code remains skill/rules based.

## Install from a repo checkout

If you are working from this repository directly instead of the published npm package:

```bash
npm install
npm run build
chmod +x dist/bin/lcm.js
npm link
```

If you do not want a global link, run `node dist/bin/lcm.js ...` instead of `lcm ...` in the commands below.

## Install the VS Code connector

For GitHub Copilot in VS Code:

```bash
lcm connectors install github-copilot
lcm connectors doctor github-copilot
```

This writes a repo-local skill file at `.github/skills/lcm-memory/SKILL.md`.

## Install the Codex connector

For Codex in the current repository:

```bash
lcm connectors install codex
lcm connectors doctor codex
```

This writes native Codex hook configuration:

- `.codex/hooks.json`
- `.codex/config.toml` with `[features].codex_hooks = true`

The hook connector installs these Codex events:

| Event | Command | Behavior |
|---|---|---|
| `SessionStart` | `lcm restore --client codex` | Restores project context when Codex starts, resumes, or clears a session |
| `UserPromptSubmit` | `lcm user-prompt --client codex` | Searches memory and injects prompt-time hints |
| `PostToolUse` | `lcm post-tool --client codex` | Captures passive learning signals from supported tool calls |
| `Stop` | `lcm session-snapshot --client codex` | Ingests transcript deltas and triggers compaction once the configured token threshold is reached |

Codex must trust the project `.codex/` layer for project-local hooks to load. For a global setup, run:

```bash
lcm connectors install codex --global
lcm connectors doctor codex --global
```

If you only want instruction-based guidance instead of native hooks:

```bash
lcm connectors install codex --type skill
```

To import existing Codex sessions into LCM:

```bash
lcm import --codex
lcm import --provider all
```

## Current shortcomings

1. `lcm install` is still Claude-Code-specific. Use `lcm connectors install codex` for Codex and `lcm connectors install github-copilot` for VS Code.
2. GitHub Copilot in VS Code is skill-based today. There is no automatic session restore, turn ingestion, prompt-time search injection, or compaction hook.
3. The GitHub Copilot connector does not register MCP automatically. The current supported path is instructions/skill guidance plus the `lcm` CLI.
4. Codex MCP config lives in `.codex/config.toml`, but the connector installer does not edit TOML yet. `lcm connectors install codex --type mcp` only prints manual instructions.
5. Codex `Stop` hooks are turn-scoped, not final-session hooks. LCM therefore uses rolling snapshots and thresholded compaction instead of marking Codex sessions complete on each `Stop`.
6. The top-level branding and install flow were originally Claude-first, so documentation drift is still a risk whenever new clients are added.

## Improvement candidates

1. Add first-class `lcm setup vscode` and `lcm setup codex` commands instead of overloading `lcm install`.
2. Add TOML read/write support so Codex MCP setup can be automated.
3. Add a real VS Code runtime adapter for restore, writeback, and prompt-time recall instead of skill-only guidance.
4. Expand connector diagnostics to validate Codex feature flags and hook event coverage.
