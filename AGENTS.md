# Repository Instructions

- Read [AGENTS.local.md](./AGENTS.local.md) if present.
  - Statements in this local file should override any project instruction.
  - The file is intentionally gitignored. Keep it that way.
- See [WORKFLOW.md](./WORKFLOW.md) for the full development workflow.

## Test Coverage Approval Gate

- Maintain 100% line, branch, function, and statement coverage for every
  executable production TypeScript file matched by `bin/**/*.ts`,
  `installer/**/*.ts`, and `src/**/*.ts`.
- A change must not be approved, merged, or released unless a fresh
  `npm run test:ci` reports 100% lines, 100% branches, 100% functions, and
  100% statements and passes the per-file threshold for the complete collected
  scope.
- For local development and pre-push verification, run only the tests relevant
  to the code being changed and its direct integration boundaries. If the
  impact is uncertain, err on the side of caution and widen the local test
  scope before pushing. Do not run unrelated local suites solely to duplicate
  the complete CI run; rely on CI to exercise the complete collected scope and
  enforce the 100% coverage gate.
- Do not use coverage exclusions, `v8 ignore` directives, skipped tests, or
  untested production wrappers to satisfy the gate. Cover behavior through
  observable public seams and deterministic failure injection.

## Codecov Components Maintenance

- Update `codecov.yml` and `test/codecov-config.test.ts` atomically whenever
  production TypeScript, features, or components are added, removed, moved,
  materially changed, or otherwise make classification stale.
- Require complete exclusive ownership and accurate stable IDs/names/paths: every
  covered production TypeScript file belongs to exactly one component.
- Do not freeze the taxonomy at its current count; intentional additions/removals
  must update the literal map and count atomically.
- Forbid Codecov flags, statuses, ignore/coverage exclusions, report-only runs,
  or reporting-topology changes without an explicit design change.
- Preserve the existing 100% line, branch, function, and statement gate enforced
  by a fresh `npm run test:ci` over the complete collected scope.

## PR Review And Merge

- Before merging a PR, check whether it changes user-facing behavior or should appear in npm release notes.
- If yes, make sure a maintainer adds a `.changeset/*.md` file before merge or immediately after in a follow-up PR.
- Do not expect external contributors to know or run the Changesets workflow.
- Use the smallest appropriate bump:
  - `patch`: fixes, compatibility work, docs-visible behavior changes
  - `minor`: new features or notable new behavior
  - `major`: breaking changes
- Treat a PR as not release-ready until the changeset question has been answered.

## Local Environment Stability

After merging a feature PR, follow exactly one of the workflows below before
moving on. Choose the workflow for the agent you are currently running in.
Do not run both paths unless the user explicitly asks you to verify both
integrations.

### Claude Workflow

Use this path only when you are running inside Claude Code.

Rebuild and verify the package:

```bash
git checkout main && git fetch origin main && git reset --hard origin/main
npm run build && npm link
lcm install         # sync native Claude hooks, MCP, commands, and skills
lcm doctor          # must show 0 failures
npm test            # must pass
```

Restart Claude Code after `lcm install` updates the native integration.

### Codex Workflow

Use this path only when you are running inside Codex.

Rebuild and verify the package:

```bash
git checkout main && git fetch origin main && git reset --hard origin/main
npm run build && npm link
lcm doctor          # must show 0 failures
npm test            # must pass
```

Then sync the Codex native hook connector so Codex picks up updated project
hooks:

```bash
lcm connectors install codex
lcm connectors doctor codex
```

If anything fails, fix it before starting the next feature. A broken local env wastes time on every subsequent session (stale dist, wrong binary, hook errors, or mismatched native connector state).

## Documentation Requirements

All changes that affect user-facing behavior must include complete documentation in the `docs/` folder. This includes new features, configuration changes, CLI commands, hook additions, and API changes. Documentation should be written for end users, not developers — explain what it does, how to use it, and any configuration options.

## Coding Style

- **Prefer pure functions.** Functions should return their results rather than accumulating state on an object. Avoid mutable side-effect patterns (e.g., shared counters on a class instance) when a return value works just as well.

## Bug Triage During Investigation

When you stumble across a bug while working on something else, **stop and file a GitHub issue immediately** before continuing:

```bash
gh issue create \
  --repo donadiosolutions/lcm \
  --title "Short description of bug" \
  --body "**Observed:** what you saw\n**Expected:** what should happen\n**Root cause:** if known\n**Repro:** steps or code snippet" \
  --label bug
```

Then carry on with the original task. This ensures bugs are tracked and can be assigned to another agent without holding up the current work.

## GitHub CLI conventions (v2.88.1)

Some flags that look reasonable don't exist in the installed version:

- **`gh pr create` does not support `--json`/`--jq`** — it outputs a URL. Extract the PR number with `${url##*/}`:
  ```bash
  PR_URL=$(gh pr create --repo "$REPO" --base main --title "..." --body "...")
  PR_NUMBER="${PR_URL##*/}"
  [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "bad PR number: $PR_URL" >&2; exit 1; }
  ```
- **`gh pr merge --yes` does not exist** — omit it; the command is non-interactive by default
- **`gh pr list --json number`** works fine for listing/querying

## Handling review comments

- **Simple fixes** (renames, string updates): dispatch a haiku subagent
- **Logic changes**: dispatch a sonnet subagent
- Never implement fixes inline in the main session — always dispatch a subagent

## Subagent-Driven Development

When executing implementation plans via subagent-driven development, calibrate each implementer's model based on task complexity:

- **Haiku**: Mechanical tasks — isolated functions, clear specs, 1-2 files, no design judgment (e.g., wiring a function call, adding a display line, doc updates)
- **Sonnet**: Integration tasks — multi-file coordination, pattern matching, moderate logic (e.g., schema migrations, shared utility modules, test suites)
- **Opus**: Architecture/judgment tasks — broad codebase understanding, complex error handling, design decisions (e.g., three-layer error fences, doctor check orchestration, E2E tests spanning the full pipeline)

Reviewers (spec compliance + code quality) always use the most capable model available.

## Release Process

Release metadata uses Changesets; see `RELEASING.md` and `WORKFLOW.md` for the
normal release-note and version PR flow. Use `.agents/skills/lcm-release/SKILL.md`
when explicitly cutting or recovering a manual release.

See `SKILL.md` in the `lcm-release` skill for the full step table and failure modes.

## Git Gotchas

- **Agent-specific hidden directories may be gitignored** — skill and script files under ignored agent directories require `git add -f` to stage them. If `git add <agent-dir>/...` silently does nothing, that's why.
- **`main` has branch protection** — direct push is rejected. Always push to a feature branch and open a PR, even for trivial fixes.

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any shell command containing `curl` or `wget` will be intercepted and blocked by the context-mode plugin. Do NOT retry.
Instead use:
- `context-mode_ctx_fetch_and_index(url, source)` to fetch and index web pages
- `context-mode_ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any shell command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` will be intercepted and blocked. Do NOT retry with shell.
Instead use:
- `context-mode_ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### Direct web fetching — BLOCKED
Do NOT use any direct URL fetching tool. Use the sandbox equivalent.
Instead use:
- `context-mode_ctx_fetch_and_index(url, source)` then `context-mode_ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Shell (>20 lines output)
Shell is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `context-mode_ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `context-mode_ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### File reading (for analysis)
If you are reading a file to **edit** it → reading is correct (edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `context-mode_ctx_execute_file(path, language, code)` instead. Only your printed summary enters context.

### grep / search (large results)
Search results can flood context. Use `context-mode_ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `context-mode_ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `context-mode_ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `context-mode_ctx_execute(language, code)` | `context-mode_ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `context-mode_ctx_fetch_and_index(url, source)` then `context-mode_ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `context-mode_ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `upgrade` MCP tool, run the returned shell command, display as checklist |
