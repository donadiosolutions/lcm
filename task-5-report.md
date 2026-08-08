# Task 5 Report

## Finding 5 — linked-worktree orphan sidecar identity recovery

Status: fixed.

Root cause: sidecar creation derives an unmapped local project ID through the
Git-anchor-aware `normalizeProjectIdentityPath`, while the mapless orphan
fallback hashed the lexical/realpath-only `normalizeProjectPath`. A linked
worktree CWD that disappeared therefore could not recover the sidecar created
under the primary checkout's anchor hash.

Fix: `src/db/events-path.ts` now applies the same anchor-aware identity rule to
the existing-only fallback. When the requested CWD is gone, it checks the
nearest existing ancestor and adopts that ancestor only when it resolves to a
distinct linked-worktree anchor; ordinary mapless paths retain the previous
exact-path fallback. Recovery still returns only an existing sidecar and never
creates or publishes `map.json` state.

Evidence: `test/db/events-path.test.ts` proves anchor-sidecar recovery after a
linked-worktree CWD disappears, while retaining map identity, legacy mapless,
malformed-metadata, no-sidecar, and read-only recovery coverage.

Focused verification:

- `npx vitest run test/db/events-path.test.ts`: 9 tests passed.
- Focused V8 coverage for `src/db/events-path.ts`: 100% statements, branches,
  functions, and lines.
- `npx eslint src/db/events-path.ts test/db/events-path.test.ts`: passed.
- `npm run typecheck`: blocked by pre-existing base errors in
  `src/doctor/doctor.ts:116` and duplicate exports in `src/storage/index.ts`;
  neither file is in this finding's write set.
