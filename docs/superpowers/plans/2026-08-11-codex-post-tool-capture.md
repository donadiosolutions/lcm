# Codex PostToolUse Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #604 by persisting bounded passive-learning events for observed native Codex exec payloads and making connector doctor prove both structural and no-write functional coverage.

**Architecture:** Introduce one pure normalization module between untrusted hook JSON and the existing extractor. The module allowlists native Codex exec names and bounded command/status fields, reuses canonical Bash semantics, and is shared by `handlePostToolUse` and a deterministic connector-doctor probe; raw input/output is never persisted.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node.js 25.9.0, SQLite event sidecar, Codex connector JSON, Git.

## Global Constraints

- Start only after the CLI PR for #602/#603 merges. Fetch updated `origin/main`, create a fresh isolated worker workspace at `UPDATED_MAIN=$(git rev-parse --verify 'origin/main^{commit}')`, require `test "$(git rev-parse HEAD)" = "$UPDATED_MAIN"`, persist it with `git update-ref refs/lcm/implementation-bases/issue-604-codex-post-tool "$UPDATED_MAIN"`, and create branch `fix/604-codex-post-tool-capture` from that durable ref; never use a `codex/` prefix.
- Do not use, clean, stage, or modify the coordinator worktree or pre-existing files outside this branch.
- Add no dependency and preserve exact pins and lockfile integrity.
- Recognize only `client: "codex"` payloads with `functions.exec` or `functions.exec_command` names and explicit bounded command fields. Copy at most 2,000 command characters plus a literal `...` truncation marker into the canonical in-memory shape; no raw command object survives normalization.
- Never serialize raw `tool_input`, `tool_response`, stdout, stderr, or unknown output into an event. The bounded command is used only by the allowlisted semantic extractor, and extracted event data passes through the existing built-in and project-aware scrubber before enqueue.
- Preserve feedback-loop exclusions, built-in/project scrubbing, truncation, and append-before-project-metadata ordering.
- Functional doctor is pure/no-write and must not touch the user's event database.
- The existing `unit-hooks` directory path already exclusively owns the new production file. Update `codecov.yml` atomically with the count test by documenting that the directory path owns native hook adapters, but do not add a redundant exact-file path; update the literal expected production-file count in `test/codecov-config.test.ts`.
- Update user documentation and add one patch Changeset.
- GPG-sign every commit and include DCO `--signoff`.

---

### Task 1: Normalize native Codex exec payloads with pure bounded semantics

**Files:**
- Create: `src/hooks/post-tool-normalization.ts`
- Modify: `src/hooks/extractors.ts` (export the canonical `PostToolInput` type)
- Create: `test/hooks/post-tool-normalization.test.ts`

**Interfaces:**
- Consumes: raw fields `{ client, tool_name, tool_input, tool_response, tool_output }`.
- Produces: `normalizePostToolInput(input: RawPostToolInput): PostToolInput` and `codexPostToolFunctionalCoverage(): boolean`.

- [ ] **Step 1: Add pure RED fixtures**

Create table-driven tests for:

```ts
[
  {
    client: "codex",
    tool_name: "functions.exec",
    tool_input: { command: "git commit -m 'bounded message'" },
    expectedType: "git_commit",
  },
  {
    client: "codex",
    tool_name: "functions.exec_command",
    tool_input: { cmd: "npm install exact-package" },
    expectedType: "env_install",
  },
]
```

Normalize each fixture, pass it to `extractPostToolEvents`, and assert the existing event type/category/priority. Add negative fixtures for non-Codex clients, unknown `functions.*` names, non-string `cmd`/`command`, lcm-store feedback-loop names, and response objects containing a sentinel secret. Assert the secret never appears in normalized input or event data.

Add status fixtures with this exact policy: inspect only top-level status fields in record-valued `tool_output` and `tool_response`, consulting `tool_output` first. Within one record, select the first valid field in this precedence order: boolean `isError`, boolean `is_error`, finite numeric `exit_code`, finite numeric `exitCode`. A boolean maps directly, numeric zero maps to false, and every other finite number maps to true. A valid false/zero wins. Strings, nested objects, `NaN`, and infinities are invalid and ignored. Fall back to `tool_response` only when `tool_output` contains no valid recognized field. If neither source contains one, omit canonical `tool_output`. Add conflict and invalid-field fixtures proving every source and field precedence rule.

No captured structured Codex file-operation shape is available in #604. Add negative fixtures proving nested/unknown `operation`, `path`, and file-like fields cannot produce file events, and shell text such as `cat`, `sed`, `rm`, or redirects is never parsed into file events. Do not invent a structured mapping without a real captured payload.

Define native feedback-loop suppression before status projection: a trimmed native command matching `^lcm\s+store(?:\s|$)` produces no canonical event even when status reports an error. Keep existing tool-name feedback-loop suppression unchanged and add success/error fixtures.

- [ ] **Step 2: Run RED**

```bash
npm exec -- vitest run test/hooks/post-tool-normalization.test.ts
```

Expected: the module/import is missing and native fixtures cannot produce canonical Bash events.

- [ ] **Step 3: Implement the pure adapter**

Use exported bounded types:

```ts
export interface RawPostToolInput {
  readonly client?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly tool_output?: unknown;
}

export function normalizePostToolInput(input: RawPostToolInput): PostToolInput {
  // Return the existing canonical shape for non-Codex tools.
  // For the two allowlisted Codex names, return tool_name: "Bash" and
  // tool_input: { command } using only a string command/cmd field.
  // Project only bounded status using the documented source/field precedence;
  // copy no response/output payload and suppress native `lcm store` commands.
}
```

Keep command selection deterministic: when `command` is a string it wins even
when blank; only if it is not a string may a string `cmd` be selected. Trim only
to decide whether the selected command is empty and to apply the native
feedback-loop matcher; do not fall back from a blank string `command` to `cmd`.
An empty or missing selected command produces an inert canonical input and no
event regardless of status. Bound a non-empty selected command before extraction
to its first 2,000 UTF-16 code units plus `...` when truncated. This mirrors the
existing event-data soft cap while preventing an unbounded raw command from
entering the extractor. Extracted data is then scrubbed by the existing
project-aware event scrubber before any durable write.

Implement functional coverage from fixed benign fixtures:

```ts
export function codexPostToolFunctionalCoverage(): boolean {
  const fixtures = [
    { tool_name: "functions.exec", tool_input: { command: "git branch" }, expected: "git_branch" },
    { tool_name: "functions.exec_command", tool_input: { cmd: "npm install probe" }, expected: "env_install" },
  ];
  return fixtures.every(({ expected, ...fixture }) => {
    const events = extractPostToolEvents(normalizePostToolInput({ client: "codex", ...fixture }));
    return events.length === 1 && events[0]?.type === expected;
  });
}
```

The probe is in-memory only.

- [ ] **Step 4: Run GREEN and existing extractor suite**

```bash
npm exec -- vitest run test/hooks/post-tool-normalization.test.ts test/hooks/extractors.test.ts
```

Expected: all tests pass and existing Claude/MCP semantics are unchanged.

- [ ] **Step 5: Update the Codecov production count and commit**

Do not add a redundant ownership path: `unit-hooks` already owns every file under `src/hooks/`. In `codecov.yml`, add or update a descriptive comment on that existing directory path to state that it includes native hook adapters, leaving the path value unchanged. Keep the expected component path array unchanged. Update the expected production-file count in `test/codecov-config.test.ts` from 190 to 191 after the file exists, then run the exclusive-ownership test and prove the new file is owned exactly once. These two taxonomy files must be staged and committed atomically per repository policy.

```bash
git add src/hooks/post-tool-normalization.ts src/hooks/extractors.ts \
  test/hooks/post-tool-normalization.test.ts codecov.yml test/codecov-config.test.ts
git commit -S --signoff -m "fix(hooks): normalize native Codex exec calls"
```

### Task 2: Persist normalized events through the real hook path

**Files:**
- Modify: `src/hooks/post-tool.ts`
- Modify: `test/hooks/post-tool.test.ts`
- Modify: `test/hooks/dispatch.test.ts`
- Modify: `test/bin/lcm-run-cli.test.ts`

**Interfaces:**
- Consumes: `normalizePostToolInput` from Task 1 and top-level payload `client` injected by `--client codex`.
- Produces: one scrubbed local sidecar row for each recognized native semantic event.

- [ ] **Step 1: Add persisted-event RED tests**

Call `handlePostToolUse` with a temporary cwd and `client: "codex"`. Open the temporary `EventsDb` and assert exact row/no-row outcomes through a table-driven matrix covering both native names; `command` and `cmd`; successful Git/environment events; `isError`, `is_error`, nonzero `exit_code`, and nonzero `exitCode` error events; zero codes producing normal semantics; both fields present with `command` precedence; response/output stdout, stderr, and secret sentinels never persisted; native `lcm store` success/error feedback loops producing no row; unknown `functions.*`; malformed/non-record input; missing commands; non-Codex clients; and missing/invalid session IDs.

Use command fixtures that trigger existing bounded semantics:

```ts
{ tool_name: "functions.exec", tool_input: { command: "git branch capture-test" } }
{ tool_name: "functions.exec_command", tool_input: { cmd: "npm install capture-test" } }
```

Every error case must persist only the bounded `error_tool` data; no raw response/output field may survive. Unit normalizer tests do not replace this real persistence-path matrix.

- [ ] **Step 2: Run RED**

```bash
npm exec -- vitest run test/hooks/post-tool.test.ts \
  -t "native Codex|non-Codex native"
```

Expected: recognized calls exit zero but produce no sidecar rows.

- [ ] **Step 3: Route through normalization**

Extend `PostToolHookInput` with `client?: unknown` and replace the direct extractor input with:

```ts
const extractedEvents = extractPostToolEvents(normalizePostToolInput(input));
```

Do not change scrub/enqueue/publication-fence ordering. Add a CLI-level test invoking `post-tool --client codex` with piped JSON and asserting mocked `dispatchHook` receives top-level `client: "codex"`; separately retain a direct dispatch test proving it forwards that payload unchanged.

- [ ] **Step 4: Run GREEN and adjacent hook suites**

```bash
npm exec -- vitest run test/hooks/post-tool.test.ts test/hooks/dispatch.test.ts \
  test/hooks/extractors.test.ts test/hooks/post-tool-normalization.test.ts \
  test/bin/lcm-run-cli.test.ts
```

Expected: all tests pass; recognized native events persist and unrecognized inputs remain best-effort no-ops.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/post-tool.ts test/hooks/post-tool.test.ts \
  test/hooks/dispatch.test.ts test/bin/lcm-run-cli.test.ts
git commit -S --signoff -m "fix(hooks): persist Codex exec context"
```

### Task 3: Make connector doctor prove structural and functional coverage

**Files:**
- Modify: `src/connectors/codex-hooks.ts`
- Modify: `test/connectors/codex-hooks.test.ts`
- Modify: `bin/lcm.ts`
- Modify: `test/bin/lcm-run-cli.test.ts`
- Modify: `test/connectors/installer.test.ts` if structural detection changes connector listing

**Interfaces:**
- Consumes: the canonical Codex hook path resolved exactly like installation and `codexPostToolFunctionalCoverage()`.
- Produces: `inspectCodexPostToolHook(path): { state: "absent" | "incomplete" | "installed"; functional: boolean }` or an equivalently bounded discriminated result.

- [ ] **Step 1: Add structural RED matrix**

Test that structural health is true only when `hooks.PostToolUse` is an array containing an object group with matcher exactly `*`, whose hooks array contains an object with type exactly `command` and command exactly `lcm post-tool --client codex`. Cases with only SessionStart, wrong/missing matcher, wrong hook type/client, extra command arguments, missing command, malformed PostToolUse, malformed JSON, or absent file are not structurally healthy.

Keep broad `hasCodexHooks`/`listConnectors` discovery behavior unchanged. Add a RED characterization showing broad discovery accepts a partial LCM installation while exact structural inspection reports incomplete; this proves the semantic defect rather than failing only because a new export is absent.

- [ ] **Step 2: Add CLI doctor RED tests**

For targeted installed Codex connector doctor, require output that distinguishes:

```text
✓ Codex: PostToolUse hook installed
✓ Codex: native exec capture functional
```

Targeted doctor must inspect the canonical `~/.codex/hooks.json` path using the same default/`--global` resolution as installation even when broad discovery finds only a partial installation. Preserve existing connector path output, then print structural and functional lines. Distinguish absent, incomplete, and installed-but-nonfunctional states; never print functional success when structure is absent/incomplete. Print `Codex: native exec capture functional check skipped` when structure is absent or incomplete. Mock functional failure and assert actionable output plus exit 1.

Make the pure probe mockable before module import through an injected dependency or module mock. Assert doctor does not call `appendLocalHookEvents`, instantiate `EventsDb`, write hook files, or create an event database.

- [ ] **Step 3: Run RED**

```bash
npm exec -- vitest run test/connectors/codex-hooks.test.ts \
  test/bin/lcm-run-cli.test.ts test/connectors/installer.test.ts \
  -t "PostToolUse|native exec capture|connector health"
```

Expected: existing broad `hasCodexHooks` accepts partial hook files and doctor only lists paths.

- [ ] **Step 4: Implement exact structural inspection and no-write probe**

Keep broad connector discovery compatibility and its existing output unchanged. Targeted health calls the exact structural inspector and only then the in-memory functional probe. Aggregate failures and call `exit(1)` only after printing all requested agent results. The probe imports only the pure normalizer/extractor path: it must not import or call `handlePostToolUse`, `appendLocalHookEvents`, `EventsDb`, or filesystem setup. Non-Codex connector behavior remains unchanged.

- [ ] **Step 5: Run GREEN**

```bash
npm exec -- vitest run test/connectors/codex-hooks.test.ts \
  test/bin/lcm-run-cli.test.ts test/connectors/installer.test.ts
```

Expected: all tests pass and no functional probe writes state.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/codex-hooks.ts bin/lcm.ts \
  test/connectors/codex-hooks.test.ts test/connectors/installer.test.ts \
  test/bin/lcm-run-cli.test.ts
git commit -S --signoff -m "fix(connectors): diagnose Codex capture coverage"
```

### Task 4: Document passive capture and add release metadata

**Files:**
- Modify: `docs/passive-learning.md`
- Modify: `docs/hook-protocol.md`
- Modify: `docs/vscode-codex.md`
- Create: `.changeset/capture-codex-exec-context.md`

- [ ] **Step 1: Update user contracts**

Document the two native exec names, bounded semantic capture, exclusion of raw output and unknown payloads, event scrubbing, exact installed-hook requirement, and no-write functional doctor probe.

- [ ] **Step 2: Add patch Changeset**

```md
---
"@donadiosolutions/lcm": patch
---

Capture native Codex exec context safely and verify it through connector diagnostics.
```

- [ ] **Step 3: Run documentation/config tests**

```bash
npm exec -- vitest run test/cli-help.test.ts test/codecov-config.test.ts \
  test/connectors/codex-hooks.test.ts test/connectors/installer.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 4: Commit**

```bash
git add docs/passive-learning.md docs/hook-protocol.md docs/vscode-codex.md \
  .changeset/capture-codex-exec-context.md
git commit -S --signoff -m "docs(codex): describe native tool capture"
```

### Task 5: Verify the complete branch

- [ ] **Step 1: Run focused hook/connector suite**

```bash
npm exec -- vitest run test/hooks test/connectors test/bin/lcm-run-cli.test.ts \
  test/codecov-config.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run static and coverage gates**

```bash
npm run build
npm run typecheck
npm run lint
npm run test:ci
```

Expected: all commands exit zero and complete/per-file coverage is exactly 100% for lines, branches, functions, and statements.

- [ ] **Step 3: Audit scope**

```bash
IMPLEMENTATION_BASE=$(
  git rev-parse --verify 'refs/lcm/implementation-bases/issue-604-codex-post-tool^{commit}'
)
git diff --check "$IMPLEMENTATION_BASE"...HEAD
git status --short
git log --show-signature --format=fuller "$IMPLEMENTATION_BASE"..HEAD
```

Expected: clean worktree, valid signatures/DCO, no raw-payload logging, exact Codecov ownership, and no dependency change.

### Task 6: Run the required MoM whole-branch review sequence

- [ ] **Step 1: Produce exact-head review package**

Record `HEAD`, the implementation base, full commit list, test evidence, and complete diff in the plan's SDD workspace.

- [ ] **Step 2: Run parallel adversarial review**

Dispatch `cortex-hq/zai-org-GLM-5.2` and `xai/grok-4.5` at maximum effort over the whole branch. Give both the plan/spec, exact review package, and verification evidence.

- [ ] **Step 3: Run Opus second pass**

Give `anthropic/claude-opus-5` at medium effort the exact branch plus complete GLM and Grok reports. Any Critical/Important finding returns to a maximum-effort Luna worker, followed by focused/full verification and fresh review before publication.
