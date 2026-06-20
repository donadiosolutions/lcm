# @donadiosolutions/lcm

## 1.2.1

### Patch Changes

- b6a3aeb: Document the `lcm map` command in the README CLI reference.
- 8918eef: Reduce generated connector rules context while preserving `lcm --help` guidance.

## 1.2.0

### Minor Changes

- a7dcf08: Add `~/.lcm/map.json` project path alias routing and the `lcm map` CLI for listing, showing, adding, and removing aliases.

## 1.1.1

### Patch Changes

- 7f527b6: Normalize product naming to Long Context Manager (LCM), keep Codex connector prompts free of Claude-specific wording, and preserve legacy install migration and cleanup through generated compatibility identifiers.

## 1.1.0

### Minor Changes

- 4c7b46c: Process passive-learning sidecar events automatically in the daemon after hook capture, with bounded active-project drains, startup and periodic sidecar sweeps, and doctor messaging that treats small queued backlogs as pending automatic processing while warning at larger remediation-worthy backlogs.

### Patch Changes

- c5218fe: Fix release maintenance edge cases: publish release notes now extract Changesets changelog entries written as either `## 1.2.3` or `## [1.2.3]`, doctor no longer suggests the unsupported `lcm daemon restart` command, the manual release workflow now follows the repository's main-only branch layout and creates a changelog block before tagging, and automated release metadata stays on the Changesets path.
- 7c419d7: Prune empty or stale orphan passive-learning sidecars during sidecar scans, and report doctor sidecars skipped by scan budgets as skipped instead of warnings. `lcm doctor` also now accepts `--events-max-dbs <n|all|unlimited>` to control the passive-learning sidecar scan count limit.

## 1.0.2

### Patch Changes

- 1aee2a8: Add `lcm events promote --all` to drain queued passive-learning events from all metadata-backed sidecars, and update doctor messaging to recommend that command when the daemon is healthy but old sidecar backlogs remain.

## 1.0.1

### Patch Changes

- e342a65: Preserve existing user content in Codex AGENTS.md while installing or updating the LCM rules block.

## 1.0.0

### Major Changes

- 9632840: Update Codex hook setup to use the current `hooks` feature flag and migrate existing `codex_hooks` entries when installing the connector.
- 9632840: Install Codex hooks, skill, and rules by default, write Codex hooks to `~/.codex/hooks.json`, and make the Codex rules connector idempotently maintain `~/.codex/AGENTS.md`.
- 9632840: Move LCM runtime storage from the legacy runtime directory to `~/.lcm` and migrate legacy runtime data automatically on startup.

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
