# Migration rehearsal gate report

Result of the complete cutover rehearsal for [#628](https://github.com/donadiosolutions/lcm/issues/628): 41 generated rows, **verdict pass-with-documented-limits**, no pending row, cleanup clean. The machine-readable record (the output of the assembler, validated against the evidence schema) is [migration-rehearsal-gate.json](migration-rehearsal-gate.json). How to read and rerun the rehearsal is described in [migration-rehearsal.md](migration-rehearsal.md).

## Tested inputs

| Item | Value |
| --- | --- |
| Tested commit | 41e046ba3f8471b51f16c788ada86af64124548c |
| Tree dirty | false (unchanged after the run: true) |
| Tested inputs SHA-256 | 7fd44242422560766c6920bed31064636734da6ef3bbd04da074c2f76b9921b8 (1709 tracked paths, gate files excluded) |
| Lockfile SHA-256 | af535747557d6a7e9bd51e464c51e3ec52a9773a5d4c0750b35f1dfcb19907c4 |
| Built CLI (dist/lcm.mjs) SHA-256 | ced1334863e928dfe940cd3c67d5ff7eb3f5bc069e6f593893d09325738d03e6 |
| Node.js / pnpm | v25.9.0 / 10.34.5 |
| Container runtime | podman (rootless) |
| Database image | postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296 |
| Observed image digest | sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296 |
| Observed server | PostgreSQL 18.4 (Debian 18.4-1.pgdg12+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit (server_version_num 180004) |
| Manifest SHA-256 | 916ed02eba29d1b2e7c9108eb0374922ceafbc443e79374df908048bf9c4c91f |

## Commands

| Command | Exit | Elapsed | Harness run id |
| --- | --- | --- | --- |
| `LCM_TEST_CONTAINER_CLI=podman LCM_MIGRATION_REHEARSAL_EVIDENCE_DIR=<private evidence dir> timeout 75m pnpm run test:postgresql:cutover-rehearsal` | 0 | 1156 s | 2d70b84f2a2c2debf3a29ca78818d89e |
| `LCM_TEST_CONTAINER_CLI=podman timeout 75m pnpm run test:postgresql (default profile)` | 1 | 1112 s | 66e1c4568966dfc1cd0f15dbccea9b24 |

The default profile run failed only in test/postgresql/surface-parity.integration.ts (the known local failure of this slice: its worker reports surface-parity-parent:owned-cleanup-failed and the harness diagnostic exceeds the capture limit). That file alone was ignored; every other file passed: 50 of 51 files, 453 tests passed and 16 (all in that file) skipped. The rehearsal file was part of that run.

## Workload and thresholds

Profile full, 1 Vitest worker. Bounds: `{"largeFixture":{"conversations":300,"messagesPerConversation":15,"messages":4500,"parts":4500,"otherRecords":8,"plannedRecords":9308,"maxPortableRecords":10000,"applyMaxRecords":500,"applyMaxBytes":16777216},"setFixture":{"projects":2,"secondProjectConversations":1,"secondProjectMessages":2},"aliasFixture":{"aliasPathsPerProject":128},"maxHookEventsPerRow":32,"cliChildDeadlineMs":110000,"cliOutputCapBytes":65536,"daemonDeadlineMs":90000}`. Thresholds: `{"harnessTimeoutMinutes":75,"rowTimeoutMs":{"default":300000,"large":900000,"set":900000},"verdictRequires":"every generated row passes, every pending row is listed, cleanup receipt is clean"}`. The 41 rows ran in 1103.2 s of scenario time inside a 1156 s command.

## Rows

| Row | Verdict | Seconds |
| --- | --- | --- |
| F1-empty | pass | 15.7 |
| F1-empty-project | pass | 15.8 |
| F1-representative | pass | 15.3 |
| R1 | pass | 12.3 |
| R2 | pass | 16.5 |
| R3 | pass | 18.3 |
| R3-replicated | pass | 18.5 |
| F4 | pass | 12.2 |
| F11-tampered | pass | 10.5 |
| F11-replaced | pass | 10.6 |
| F11-partial | pass | 2.4 |
| F1-alias | pass | 32.9 |
| F1-large | pass | 403.3 |
| F1-legacy | pass | 2.0 |
| F2 | pass | 15.6 |
| F7a | pass | 14.4 |
| F7b | pass | 14.0 |
| F7c | pass | 13.9 |
| F7d | pass | 14.1 |
| F8 | pass | 15.3 |
| F3 | pass | 18.3 |
| F9 | pass-with-documented-limits | 16.8 |
| H2 | pass-with-documented-limits | 16.9 |
| F10 | pass | 14.8 |
| F10-no-target-env | pass | 14.9 |
| F5 | pass | 14.3 |
| F5-delivery | pass | 14.9 |
| F6 | pass | 14.7 |
| F6b | pass | 17.6 |
| F6b-delivery | pass | 17.6 |
| R6a | pass | 21.5 |
| R6b | pass | 19.0 |
| R5 | pass | 19.0 |
| R4 | pass | 18.0 |
| L1 | pass-with-documented-limits | 19.2 |
| S1 | pass | 30.4 |
| S2 | pass | 23.9 |
| S3 | pass | 38.5 |
| S4 | pass | 25.1 |
| S4b | pass | 35.5 |
| I5 | pass | 18.4 |

Documented limits (the only rows that are not plain pass; each row and the manifest name the limit):

- F9: docs/migration-operations.md#fencing-residue-what-this-command-group-does-not-protect-against - unavailable: detection of a disconnected installation that writes concurrently.
- H2: docs/migration-operations.md#fencing-residue-what-this-command-group-does-not-protect-against - unavailable: joining an independent SQLite history into a shared project.
- L1: https://github.com/donadiosolutions/lcm/issues/1529 - unavailable: authenticated abort / completion of a prepared selection whose destination drifted.

## Cleanup receipt

Assembled after the harness exited (run id 2d70b84f2a2c2debf3a29ca78818d89e): verdict **clean**. Labelled containers left: 0; networks: 0; volumes: 0. All three label-filtered queries succeeded (exit 0), the harness exited 0, every private home root is absent and every owned child process has exited. In the JSON record the 43 private home roots are redacted: the host-specific absolute prefix of the run worker temporary directory (under the implementer private state directory) is replaced by the placeholder <run-tmp>/ and the leaf names (lcm-rh-<row>-<suffix>) are kept so each root maps to its row. Absence of every one of the 43 roots was verified on the real paths before redaction (the assembler reported tempRootsAbsent true, and a direct check found 0 of 43 present); the SHA-256 of the real paths, sorted and joined by newlines, is c1005292419697e6a323516130107ffcf18013ee0d6750844374a581566a89be.

## Recorded awaited retry (#1684)

The promote route answered with the closed "retry after the active operation completes" refusal while the daemon sweep held the publication lock (#1684, a non-blocking Bug). The rehearsal allows exactly one awaited retry for that refusal and nothing else. It happened in: F5/events-promote, F5-delivery/events-promote, F6b/events-promote, F6b-delivery/events-promote. Each of those rows passed on the single retry; no other row needed one.

## Linked Bugs

Fixes for these landed on main before the gate ran; the corresponding rows assert the successful end state.

- [#1674](https://github.com/donadiosolutions/lcm/issues/1674): migration subcommands blocked by the root bootstrap during a maintenance hold
- [#1675](https://github.com/donadiosolutions/lcm/issues/1675): report after a completed rollback exited 5
- [#1676](https://github.com/donadiosolutions/lcm/issues/1676): an empty project was not eligible to migrate
- [#1678](https://github.com/donadiosolutions/lcm/issues/1678): copy failed for projects with aliases
- [#1679](https://github.com/donadiosolutions/lcm/issues/1679): activation windows F7a and F7d could not be routed (report cell 11)
- [#1680](https://github.com/donadiosolutions/lcm/issues/1680): set rollback completedAt and report createdAt timing
- [#1681](https://github.com/donadiosolutions/lcm/issues/1681): rollback after a drained queue diverged
- [#1682](https://github.com/donadiosolutions/lcm/issues/1682): lease contention (F8, exit 4) and stale daemon (F10, exit 8) exit classes
- [#1683](https://github.com/donadiosolutions/lcm/issues/1683): /health/observe for a stale SQLite daemon
- [#1693](https://github.com/donadiosolutions/lcm/issues/1693): migrated inbox rows collided with replication uploads
- [#1694](https://github.com/donadiosolutions/lcm/issues/1694): portable export refused replicated inbox rows that are still resident
- [#1696](https://github.com/donadiosolutions/lcm/issues/1696): observe for a stale daemon started without the PostgreSQL secrets
- [#1698](https://github.com/donadiosolutions/lcm/issues/1698): rollback refused delivered events whose inbox rows replication pruned

Non-blocking Bugs that do not gate a row: #1684 (promote race, retried once above), #1689 (the H2 applied=true ordering, linked in the H2 row notes) and #1695. Open known limit: [#1529](https://github.com/donadiosolutions/lcm/issues/1529) (L1, a prepared rollback selection whose destination drifted).

## What this does not claim

- Fencing covers same-host processes of the migrating installation; F9 and H2 document that residue.
- Interruptions at module seams unwind a call; they are not power loss.
- The delivery rows drive the production replication worker in process and capture the applied inbox rows at its prune call; the PostgreSQL daemon is separately required to report a replication pass that delivered its own input (F5-delivery, F10).
- Only PostgreSQL 18.4 as pinned by the harness image digest was exercised.
