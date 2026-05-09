# @donadiosolutions/lcm

## 1.0.0

### Major Changes

- 9632840: Update Codex hook setup to use the current `hooks` feature flag and migrate existing `codex_hooks` entries when installing the connector.
- 9632840: Install Codex hooks, skill, and rules by default, write Codex hooks to `~/.codex/hooks.json`, and make the Codex rules connector idempotently maintain `~/.codex/AGENTS.md`.
- 9632840: Move LCM runtime storage from `~/.lossless-claude` to `~/.lcm` and migrate legacy runtime data automatically on startup.

## 0.9.1

### Patch Changes

- d98dae0: Harden daemon request construction, daemon timer configuration, hook fallback logging, and user-provided regular expression handling to resolve CodeQL security alerts. Hook fallback logs now use the fixed lcm log path instead of honoring `LCM_LOG_PATH`.
- b80f96b: Add native Codex hook connector support, wire Codex transcript ingestion through daemon routes, and expose the public Codex import flags.
- 6a93993: Rename the npm package scope for the fork publish path to `@donadiosolutions/lcm`.
- dcc7a5b: Add prompt-time memory injection budget and deduplication (#215)

  Recalled memories are now deduplicated and capped to a configurable byte
  budget before being injected into the prompt. Surfacing is only logged for
  memories that actually appear in the final output.

- 02a1529: Document VS Code and Codex connector setup, add the CLI memory commands used by connector skills, and fix linked `lcm` installs so symlinked binaries and authenticated daemon commands work correctly.
- f09dd71: Improve prompt-time memory recall by reranking surfaced memories using usage feedback, resurfacing cooldowns, and penalties for repeatedly ignored memories.
- a373502: Improve passive-learning promotion so repeated low-priority patterns can be auto-promoted without requiring a pre-seeded promoted memory.
- dd782cd: Add stale-memory review pipeline: detect, demote, inspect, archive, and revive promoted memories that are old and not being acted upon

## [0.8.1] - 2026-03-30

### Added

- User notification when sensitive data is filtered from LCM history (closes #178)

### Fixed

- Compact-restore test isolation — eliminate tmpdir() contamination (#184)

### Changed

- Quality-gates CI: label-based merge requirements (#185)
- autoimprove.yaml: add missing forbidden paths (closes #182) (#183)

## [0.8.0] - 2026-03-28

### Added

- Connection pooling for sidecar EventsDb (issue #131)
- Portable knowledge export/import commands — `lcm export`, `lcm import-knowledge` (issue #132)
- Pool stats observable — `lcm stats --pool` + `GET /stats/pool` daemon endpoint
- AR coverage gate CI workflow
- Copilot auto-review on all PRs

### Fixed

- `post-tool` command not registered in CLI dispatcher (#162)
- Security: upgraded hono, rollup, picomatch (3 high CVEs)
- Security: CodeQL hostname regex escaping + sanitizeError in daemon
- Atomic meta.json write in `importKnowledge` — prevents corruption on crash mid-write
- `redaction_stats` CHECK constraint migration for v0.7.0 → v0.8.0 upgrades (adds `'gitleaks'` category)

## 0.1.0

Initial release under `@donadiosolutions/lcm`.
