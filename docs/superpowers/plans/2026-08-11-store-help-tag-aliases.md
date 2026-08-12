# Store Help and Tag Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #602 and #603 by making custom help precede required-argument validation for every known command and by accepting ordered repeatable `--tag`/`--tags` aliases for `lcm store`.

**Architecture:** Resolve custom help at the first line of `runCli` using the authoritative `HELP` topic catalog from `src/cli-help.ts`, before internal-identity parsing, legacy-home migration, package-file reads, or Commander registration. Scan only arguments before `--`, preserve the explicit `help` pseudo-command and normal unknown-command handling, and keep the store alias local as one Commander option so mixed `--tag`/`--tags` occurrences share one ordered accumulator without altering `export --tags`.

**Tech Stack:** TypeScript, Commander, Vitest 4.1.10, Node.js 25.9.0, Git.

## Global Constraints

- In a fresh isolated worker workspace, resolve `REVIEWED_PLANNING_HEAD=$(git rev-parse --verify 'refs/lcm/planning/open-bugs-2026-08-11^{commit}')`, require `test "$(git rev-parse HEAD)" = "$REVIEWED_PLANNING_HEAD"`, persist it with `git update-ref refs/lcm/implementation-bases/issues-602-603-store-cli "$REVIEWED_PLANNING_HEAD"`, and create branch `fix/602-603-store-help-tag-aliases` from that exact SHA; never use a `codex/` prefix.
- Do not use, clean, stage, or modify the coordinator worktree or pre-existing files outside this branch.
- This branch owns all CLI help/store changes and merges before #604 implementation begins; the Codex-hook worker must branch from the resulting updated `main`.
- Add no dependency and preserve exact pins and lockfile integrity.
- Preserve top-level help, `help <command>`, nested parent help, unknown-command exit 1, and literal arguments after `--`.
- Help resolution must occur before daemon, filesystem, storage, or command actions.
- `export --tags` retains its existing comma-separated semantics.
- Update user docs, generated connector command reference, and add one patch Changeset.
- Do not change Codecov taxonomy unless a production file is added or moved.
- GPG-sign every commit and include DCO `--signoff`.

---

### Task 1: Make missing-argument help fail RED and resolve before Commander (#602)

**Files:**
- Modify: `test/bin/lcm-run-cli.test.ts`
- Modify: `bin/lcm.ts`
- Modify: `src/cli-help.ts`

**Interfaces:**
- Consumes: raw Node-style argv and the authoritative `HELP` topic catalog in `src/cli-help.ts`.
- Produces: pre-bootstrap `resolveCustomHelpRequest(cliArgv: string[]): CustomHelpRequest | undefined` plus `hasCommandHelp(command: string): boolean`.

- [ ] **Step 1: Add a missing-argument help matrix**

In `test/bin/lcm-run-cli.test.ts`, add table-driven cases including:

```ts
it.each([
  [["search", "--help"], "search"],
  [["grep", "--help"], "grep"],
  [["describe", "--help"], "describe"],
  [["expand", "--help"], "expand"],
  [["store", "--help"], "store"],
  [["import-knowledge", "--help"], "import-knowledge"],
  [["events", "replay", "--help"], "events"],
  [["config", "get", "--help"], "config"],
  [["config", "set", "--help"], "config"],
  [["machine", "recover", "--help"], "machine"],
  [["project", "link", "--help"], "project"],
  [["connectors", "install", "--help"], "connectors"],
  [["connectors", "remove", "--type", "--help"], "connectors"],
] as const)("renders help before required validation for %#", async (args, topic) => {
  expect((await invoke(args))?.message).toBe("exit:0");
  expect(state.printHelp).toHaveBeenCalledWith(topic);
  expect(state.ensureDaemon).not.toHaveBeenCalled();
  expect(state.post).not.toHaveBeenCalled();
  expect(state.migrateLegacyHome).not.toHaveBeenCalled();
  expect(state.configGetValue).not.toHaveBeenCalled();
  expect(state.configSetValue).not.toHaveBeenCalled();
});
```

Add boundary cases proving `unknown --help` still uses the unknown-command path, `store -- --help` does not become a help request, `help store` still renders store help, `help store --help` also renders store help, and `help --help` renders top-level help. Assert connector/project/machine action mocks and package-file reads remain untouched for every preflighted known help case.

- [ ] **Step 2: Run RED**

```bash
npm exec -- vitest run test/bin/lcm-run-cli.test.ts \
  -t "renders help before required validation|rejects removed map help|routes custom help"
```

Expected: missing-operand cases such as `store --help` fail with Commander's required-argument error before `printHelp` runs.

- [ ] **Step 3: Implement authoritative pre-bootstrap help preflight**

Export the authoritative catalog predicate from `src/cli-help.ts`:

```ts
export function hasCommandHelp(command: string): boolean {
  return Object.hasOwn(HELP, command);
}
```

Change the resolver to scan only tokens before the option terminator and preserve the explicit help pseudo-command:

```ts
function resolveCustomHelpRequest(
  cliArgv: string[],
): CustomHelpRequest | undefined {
  const args = cliArgv.slice(2);
  if (args.length === 0) return {};
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) return {};

  const terminator = args.indexOf("--");
  const optionArgs = terminator === -1 ? args : args.slice(0, terminator);
  if (!optionArgs.includes("-h") && !optionArgs.includes("--help")) return undefined;

  const [command] = optionArgs;
  if (command === "help") {
    const topic = optionArgs[1];
    return topic === undefined || topic === "-h" || topic === "--help"
      ? {}
      : { command: topic };
  }
  return { command };
}
```

At the first line of `runCli`, before `resolveInternalDaemonTestIdentity`, `migrateLegacyHomeIfNeeded`, package-file reads, or Commander registration, resolve the request and dynamically import `hasCommandHelp`/`printHelp`. Render and exit only for top-level help or a catalog-recognized topic; if the topic is unknown, continue into normal Commander setup so the existing unknown-command path and exit status remain authoritative. Remove the old late preflight block. The catalog must stay the single source of supported custom help topics.

- [ ] **Step 4: Run GREEN and boundary suite**

```bash
npm exec -- vitest run test/bin/lcm-run-cli.test.ts
```

Expected: the complete file passes, no action mock runs for help, and unknown/literal-help behavior remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add bin/lcm.ts src/cli-help.ts test/bin/lcm-run-cli.test.ts
git commit -S --signoff -m "fix(cli): resolve help before validation"
```

### Task 2: Add ordered store tag aliases (#603)

**Files:**
- Modify: `test/bin/lcm-run-cli.test.ts`
- Modify: `test/bin/memory-command-routing.test.ts`
- Modify: `bin/lcm.ts`

**Interfaces:**
- Consumes: `collectRepeatedOption(value, previous)`.
- Produces: one Commander option `--tag, --tags <tag>` exposed as `opts.tags: string[]`.

- [ ] **Step 1: Add mixed-alias RED regression**

Add a focused action test:

```ts
it("preserves mixed store tag aliases in command-line order", async () => {
  await invoke(["store", "memory", "--tag", "one", "--tags", "two", "--tag", "three"]);
  expect(state.post).toHaveBeenCalledWith("/store", expect.objectContaining({
    text: "memory",
    tags: ["one", "two", "three"],
  }));
});
```

Update command-registration assertions to require one store option whose flags contain both `--tag` and `--tags`.

In `test/bin/lcm-run-cli.test.ts`, add a real export action regression proving:

```ts
const portable = await import("../../src/portable-knowledge.js");
await invoke(["export", "--tags", "one, two"]);
expect(portable.exportKnowledge).toHaveBeenCalledWith(
  expect.any(String),
  expect.objectContaining({ tags: ["one", "two"] }),
);
```

This behavior test proves the local store alias did not alter export's comma-separated contract.

- [ ] **Step 2: Run RED**

```bash
npm exec -- vitest run test/bin/lcm-run-cli.test.ts test/bin/memory-command-routing.test.ts \
  -t "mixed store tag aliases|repeatable layer and tag options"
```

Expected: Commander rejects `--tags` or the payload lacks the ordered values.

- [ ] **Step 3: Register one dual-long option**

Change the store option to:

```ts
.option(
  "--tag, --tags <tag>",
  "Attach a tag to the stored memory (repeatable)",
  collectRepeatedOption,
  [],
)
```

Read the shared attribute in the action:

```ts
tags: normalizeStringList(opts.tags) ?? [],
```

Do not normalize argv globally and do not modify search's singular `--tag` or export's plural comma-list option.

- [ ] **Step 4: Run GREEN**

```bash
npm exec -- vitest run test/bin/lcm-run-cli.test.ts test/bin/memory-command-routing.test.ts
```

Expected: both files pass and the payload preserves mixed occurrence order.

- [ ] **Step 5: Commit**

```bash
git add bin/lcm.ts test/bin/lcm-run-cli.test.ts test/bin/memory-command-routing.test.ts
git commit -S --signoff -m "fix(cli): accept store tag aliases"
```

### Task 3: Align help, user docs, connector reference, and release note

**Files:**
- Modify: `src/cli-help.ts`
- Modify: `docs/cli.md`
- Modify: `src/connectors/templates/sections/command-reference.md`
- Modify: `test/cli-help.test.ts`
- Modify: connector template tests selected by existing repository patterns
- Create: `.changeset/clear-store-help-aliases.md`

**Interfaces:**
- Consumes: implemented help precedence and dual store option.
- Produces: one consistent user-facing contract and patch release note.

- [ ] **Step 1: Add documentation RED assertions**

Require store help and generated command reference to contain both spellings and an ordered mixed example:

```ts
expect(text).toContain("--tag, --tags <tag>");
expect(text).toContain("--tag type:solution --tags scope:lcm");
```

Run the selected help/template tests and retain the failure before editing source text.

- [ ] **Step 2: Update the authoritative help and docs**

Use this contract consistently:

```text
--tag, --tags <tag>  Attach a tag to stored memory (repeatable; aliases may be mixed)
```

Explain that `store --tags` consumes one tag per occurrence, while `export --tags` remains a comma-separated filter. Document that `--help` is resolved before required arguments and side effects for known commands.

- [ ] **Step 3: Add a patch Changeset**

```md
---
"@donadiosolutions/lcm": patch
---

Honor help before required CLI arguments and accept both repeatable store tag spellings.
```

- [ ] **Step 4: Run documentation and focused tests**

```bash
npm exec -- vitest run test/cli-help.test.ts test/bin/lcm-run-cli.test.ts \
  test/bin/memory-command-routing.test.ts test/connectors/template-service.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli-help.ts docs/cli.md \
  src/connectors/templates/sections/command-reference.md \
  test/cli-help.test.ts test/connectors/template-service.test.ts \
  .changeset/clear-store-help-aliases.md
git commit -S --signoff -m "docs(cli): document help and tag aliases"
```

### Task 4: Verify the complete branch

**Files:**
- Verify only: complete repository

- [ ] **Step 1: Run static gates**

```bash
npm run build
npm run typecheck
npm run lint
```

Expected: all commands exit zero.

- [ ] **Step 2: Run the canonical coverage gate**

```bash
npm run test:ci
```

Expected: all tests pass with exactly 100% lines, branches, functions, and statements over the complete scope.

- [ ] **Step 3: Audit scope and commits**

```bash
IMPLEMENTATION_BASE=$(
  git rev-parse --verify 'refs/lcm/implementation-bases/issues-602-603-store-cli^{commit}'
)
git diff --check "$IMPLEMENTATION_BASE"...HEAD
git status --short
git log --show-signature --format=fuller "$IMPLEMENTATION_BASE"..HEAD
```

Expected: clean worktree, valid signatures, DCO trailers, no dependency or unrelated file change.
