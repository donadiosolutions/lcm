# Migration rehearsal gate report

Result of the complete cutover rehearsal for [#628](https://github.com/donadiosolutions/lcm/issues/628): 41 generated rows, **verdict pass-with-documented-limits**, no pending row, cleanup clean. The machine-readable record (the output of the assembler, validated against the evidence schema) is [migration-rehearsal-gate.json](migration-rehearsal-gate.json). How to read and rerun the rehearsal is described in [migration-rehearsal.md](migration-rehearsal.md).

## Tested inputs

| Item | Value |
| --- | --- |
| Tested commit | b756ae414c2420e7a64cf32bf9bd849077050eff |
| Tree dirty | false (unchanged after the run: true) |
| Tested inputs SHA-256 | 810f78a5983462ead50a19f0b57542c2ed4bfa97dc8a76b70f14d01f054cf0f5 (1781 tracked paths, gate files excluded) |
| Lockfile SHA-256 | af535747557d6a7e9bd51e464c51e3ec52a9773a5d4c0750b35f1dfcb19907c4 |
| Built CLI (dist/lcm.mjs) SHA-256 | 80e817769e866615d27a0e977cf93a9247af1a842acd697373d6792467226988 |
| Node.js / pnpm | v25.9.0 / 10.34.5 |
| Container runtime | podman (rootless) |
| Database image | postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296 |
| Observed image digest | sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296 |
| Observed server | PostgreSQL 18.4 (Debian 18.4-1.pgdg12+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit (server_version_num 180004) |
| Manifest SHA-256 | dcdebf89fac3e07a1682e4e667d49e3454630cad09961fac3b186878ac7e6071 |

## Commands

| Command | Exit | Elapsed | Harness run id |
| --- | --- | --- | --- |
| `LCM_TEST_CONTAINER_CLI=podman LCM_MIGRATION_REHEARSAL_EVIDENCE_DIR=<private evidence dir> timeout 3000 pnpm run test:postgresql:cutover-rehearsal` | 0 | 1146 s | 4cb0270006e8725386b217fab84d7c77 |

The command ran the full profile with no row filter and one Vitest worker. No default-profile run is part of this record.

## Workload and thresholds

Profile full, 1 Vitest worker. Bounds: `{"largeFixture":{"conversations":300,"messagesPerConversation":15,"messages":4500,"parts":4500,"otherRecords":8,"plannedRecords":9308,"maxPortableRecords":10000,"applyMaxRecords":500,"applyMaxBytes":16777216},"setFixture":{"projects":2,"secondProjectConversations":1,"secondProjectMessages":2},"aliasFixture":{"aliasPathsPerProject":128},"maxHookEventsPerRow":32,"cliChildDeadlineMs":110000,"cliOutputCapBytes":65536,"daemonDeadlineMs":90000}`. Thresholds: `{"harnessTimeoutMinutes":75,"rowTimeoutMs":{"default":300000,"large":900000,"set":900000},"verdictRequires":"every generated row passes, every pending row is listed, cleanup receipt is clean"}`. The 41 rows ran in 1098.1 s of scenario time inside a 1146 s command.

## Rows

| Row | Verdict | Seconds |
| --- | --- | --- |
| F1-empty | pass | 15.3 |
| F1-empty-project | pass | 15.2 |
| F1-representative | pass | 15.1 |
| R1 | pass | 12.2 |
| R2 | pass | 16.0 |
| R3 | pass | 17.8 |
| R3-replicated | pass | 18.0 |
| F4 | pass | 12.2 |
| F11-tampered | pass | 10.8 |
| F11-replaced | pass | 10.9 |
| F11-partial | pass | 2.6 |
| F1-alias | pass | 34.9 |
| F1-large | pass | 416.6 |
| F1-legacy | pass | 2.0 |
| F2 | pass | 15.1 |
| F7a | pass | 13.9 |
| F7b | pass | 14.0 |
| F7c | pass | 13.5 |
| F7d | pass | 13.4 |
| F8 | pass | 14.8 |
| F3 | pass | 17.3 |
| F9 | pass-with-documented-limits | 16.5 |
| H2 | pass-with-documented-limits | 16.4 |
| F10 | pass | 14.3 |
| F10-no-target-env | pass | 14.8 |
| F5 | pass | 14.0 |
| F5-delivery | pass | 14.3 |
| F6 | pass | 14.4 |
| F6b | pass | 17.2 |
| F6b-delivery | pass | 17.1 |
| R6a | pass | 21.1 |
| R6b | pass | 18.6 |
| R5 | pass | 19.0 |
| R4 | pass | 17.7 |
| L1 | pass-with-documented-limits | 19.1 |
| S1 | pass | 30.4 |
| S2 | pass | 23.5 |
| S3 | pass | 35.9 |
| S4 | pass | 23.6 |
| S4b | pass | 32.9 |
| I5 | pass | 15.6 |

Documented limits (the only rows that are not plain pass; each row and the manifest name the limit):

- F9: docs/migration-operations.md#fencing-residue-what-this-command-group-does-not-protect-against - unavailable: detection of a disconnected installation that writes concurrently.
- H2: docs/migration-operations.md#fencing-residue-what-this-command-group-does-not-protect-against - unavailable: joining an independent SQLite history into a shared project.
- L1: https://github.com/donadiosolutions/lcm/issues/1529 - unavailable: authenticated abort / completion of a prepared selection whose destination drifted.

Promote retries: the daemon background sweep can hold the publication lock, and POST /promote-events then answers 503 with the closed busy body. The rehearsal allows exactly one awaited retry for that answer and nothing else. This run needed it in: F5, F5-delivery, F6b-delivery; each of those rows passed on the single retry.

## Cleanup receipt

Assembled after the harness exited (run id 4cb0270006e8725386b217fab84d7c77): verdict **clean**. Labelled containers left: 0; networks: 0; volumes: 0. All three label-filtered queries succeeded (exit 0), the harness exited 0, every private home root is absent and every owned child process has exited. In the JSON record the 43 private home roots are redacted: the host-specific absolute prefix of the run worker temporary directory is replaced by the placeholder <run-tmp>/ and the leaf names (lcm-rh-<row>-<suffix>) are kept so each root maps to its row. Absence of every one of the 43 roots was verified on the real paths before redaction (the assembler reported tempRootsAbsent true, and a direct check found 0 of 43 present); the SHA-256 of the real paths, sorted and joined by newlines, is dbb45c931d8ce2d7d60d55ec089f78d3db9469ace7c74adade1257bbe1b80f93.

## What this does not claim

- Fencing covers same-host processes of the migrating installation; F9 and H2 document that residue.
- Interruptions at module seams unwind a call; they are not power loss.
- The delivery rows drive the production replication worker in process and capture the applied inbox rows at its prune call; the PostgreSQL daemon is separately required to report a replication pass that delivered its own input (F5-delivery, F10).
- Only PostgreSQL 18.4 as pinned by the harness image digest was exercised.
