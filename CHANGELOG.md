# @donadiosolutions/lcm

## 1.4.3

### Patch Changes

- Update nested js-yaml, brace-expansion, fast-uri, Hono, ip-address, and
  PostCSS to patched versions, eliminating the known dependency
  vulnerabilities present in the v1.4.2 maintenance line.

## 1.4.2

### Patch Changes

- Update js-yaml, the MCP SDK and Hono server, body-parser, fast-uri, and
  brace-expansion to patched versions; exact-pin the direct dependency
  contract so consumer installations cannot retain the vulnerable runtime
  dependency paths.

## 1.4.1

### Patch Changes

- 6fedb37: Preserve passive-learning sidecars with missing timestamps, make promoted-memory search-index updates atomic, safely retain legacy message search indexes during migration, and ignore punctuation-only fallback searches.
- 12c242e: Make custom-server setup retry empty required values before safely falling back
  to the native provider, and make installer health polling reject invalid
  timeouts while using a bounded monotonic deadline.
- 5cb31b9: Keep `lcm doctor` responsive when the MCP helper exits early or its input pipe closes.
- 0f9b8ee: Allow configured and one-invocation request timeouts to govern Claude and Codex process-provider compaction instead of stopping every subprocess after a hidden 120-second limit.
- b1eaa7c: Protect local memory files with private permissions, safe atomic metadata writes, contained instruction reads, private hashed restore locks, stable project aliases, and a transcript allowlist that cannot be widened by using the filesystem root.
- 31ab876: Harden local hooks, diagnostics, connector file updates, installer parsing, and test-home isolation against unsafe path aliasing, terminal controls, unbounded sidecar reports, filesystem races, and Windows profile writes.
- cee718b: Keep flat Claude transcripts whose path only resembles a legacy nested-session path, preventing intermittent omissions during historical session import.
- 9fa4f34: Prevent nested daemon, config, map, and connector help flags from executing command actions, await unknown-command output before the CLI settles, and honor the Ninja renderer's one-shot `onReady` callback.
- 67112db: Verify daemon PID, version, and listener ownership before sending credentials or request data, and keep PostToolUse payloads from selecting notification ports.
- eb7dfd4: Scrub every persistent memory path, fence restored model content, isolate replay and ingestion state, and serialize same-project database writes.
- fb72194: Ship reproducible plugin entrypoint bundles, verify pinned Gitleaks update inputs, and prevent managed daemons from inheriting an untrusted shell path.
- 3afd311: Redact complete tokens for zero-width sensitive patterns and show `unknown` instead of an empty category in sensitive-data warnings.
- d8274d0: Prevent `lcm compact --all` from repeatedly selecting fresh-tail-only conversations, limit automatic promotion to projects compacted by the current run, and return exit status 1 when that automatic promotion fails.
- ba3e98b: Honor legacy compaction candidate limits across stored and runtime configuration, and let `lcm doctor` repair Claude settings files whose JSON root is not an object.
- 8d27ff7: Require Node.js 22.12.0 or newer for Commander 15 compatibility and align the
  development Node.js types with the supported Node 22 runtime.
- df87d63: Allow managed Linux daemons to launch process-provider CLIs installed alongside LCM without inheriting an untrusted shell path, and align doctor checks with the managed daemon environment.

## 1.4.0

### Minor Changes

- aff66cc: Add configurable OpenAI-compatible timeouts and retries, safe configuration get/set and daemon restart commands, model environment overrides, and accurate batch compaction token totals.
- a589e11: Add strict LLM configuration validation, provider aliases, and opt-in OpenAI Responses API reasoning effort for compaction.
- 3495cc7: Add provider-native reasoning effort and compaction-scoped fast-mode controls for Claude and Codex process summarizers.

### Patch Changes

- d77ed1a: Refresh the supported YAML, SDK, lint, type, and test dependencies while retaining Commander 14 compatibility with Node.js 22. Update prompt template loading for js-yaml v5's named exports.
- d063722: Prevent user-configured OpenAI retry delays from reaching timer durations directly while preserving the configured aggregate backoff.

## 1.3.0

### Minor Changes

- cb5228d: Install a Codex PreCompact hook that snapshots transcript deltas before manual or automatic compaction.
- 4f183a6: Start background daemons through the user systemd manager on Linux and have doctor repair daemons running under the wrong parent process.

## 1.2.1

### Patch Changes

- b6a3aeb: Document the `lcm map` command in the README CLI reference.
- 1b465d3: Restore generated connector command guidance while keeping rarely used directives removed from always-loaded agent rules.

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
