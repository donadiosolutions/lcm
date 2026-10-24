# Cutover rehearsal

The cutover rehearsal drives the real built `lcm` executable through the SQLite to PostgreSQL
migration, the activation, the rollback and the faults an operator can meet in between. It runs
against an isolated PostgreSQL 18 container started by the PostgreSQL test harness and writes
sanitized evidence. It answers one question: when something is interrupted, refused or lost, is
authority still held by exactly one backend, and is every acknowledged input still there?

It is test infrastructure. It adds no command and changes no runtime behavior. The result of the
last complete run is in [Rehearsal gate](migration-rehearsal-gate.md).

## What it proves

Every row starts from a private home with a real enrolled project and natively seeded data, then
runs public `lcm migration` commands in child processes (private environment, finite deadline,
process group owned to exit). Faults are injected only at seams that already exist in the
product code, or by an operating-system signal or an owned-database change. Six invariants are
checked on every row; a row may mark one not applicable only with a reason written in the
manifest.

| Invariant | Meaning |
| --- | --- |
| I1 | Durable authority (config, project map, journals) and independent consumer admission name one backend, or none while a hold fences both. Never two. |
| I2 | Every sealed snapshot and evidence file is byte-identical before and after each later step, except a file the row damaged on purpose. |
| I3 | Every acknowledged hook event is still retained with the same envelope. After a join, no event is duplicated or foreign. |
| I4 | Canonical data read independently from SQLite and PostgreSQL (per domain count and digest) matches what the row expects after activation, abort and rollback. |
| I5 | An unreachable selected PostgreSQL fails explicitly and never falls back to SQLite. Raw URLs, passwords and private paths never appear in command output. |
| I6 | The row's private homes, child processes and owned role are removed; the harness resources are audited after the harness exits. |

## Rows

The manifest [scenarios.json](../test/postgresql/cutover-rehearsal/scenarios.json) is the source
of truth for every command, exit code, reason, next step and authority checkpoint. A row asserts
the exact exit class, refusal reason and `next` the executable prints.

| Rows | Covers |
| --- | --- |
| F1-empty, F1-empty-project, F1-representative, F1-large, F1-legacy | Smallest non-empty home, an empty enrolled project, a representative home with the runtime daemon on PostgreSQL, a bounded large home with small copy batches, and a home with pre-epoch hook events. |
| F2 | The copy worker is killed with SIGKILL after its first committed batch; `report`, `resume`, `verify` and `activate` recover. |
| F3 | A server-committed copy response is lost once; the batch settles positively without a duplicate receipt. |
| F4 | The destination is changed after the copy: verification marks the generation ineligible and `abort` restores SQLite. |
| F5, F6 | Hook events around the hold, after activation and across the rollback: retained, joined once, never lost. |
| F7a, F7b, F7c, F7d | Activation interrupted after prepare completes, with the selection prepared, with the project map published but not the config, and after the drive: `report` names `activate` and the retry settles. |
| F8 | A competing verification fence and a competing publication fence are refused as contention; a superseded fencing token is refused. |
| F9, H2 | A second registered installation: the first migrates on its own and the second is untouched; a second installation with its own history for a shared project is refused. |
| F10 | A SQLite daemon alive across activation. |
| F11-tampered, F11-replaced, F11-partial | A damaged, replaced or partial sealed snapshot is classified, refused for resume and activation, and aborted without touching the source. |
| R1 to R6b | Rollback before activation (refused), before and after a guarded write, writers around the rollback fence, an interrupted rollback and a retry. |
| L1 | A prepared rollback selection with an out-of-band destination change: refused as drift, nothing forced (known limit, #1529). |
| S1 to S4b | Two-project cutover sets: the full forward flow and rollback, an interrupted preparation, an interrupted activation and rollback chain, member verification drift and a member install failure during rollback. |
| I5 | Selected PostgreSQL unreachable. |

Rows whose expected end state needs a product fix that is not on `main` yet carry a `gate`
field in the manifest. They are listed under `pending` in the evidence and are not generated. When
the fix is on `main`, remove the `gate` field; the row already asserts the successful end state.

Injected interruptions that unwind with an error (`InjectedInterruption`) model a process that
stopped at that boundary, not an operating-system crash. The one real kill (F2's copy worker, SIGKILL) is recorded as such in the row's `injections`.

## Running it

Rootless Podman is preferred. Check that no labelled harness run is live before starting one:

```bash
podman ps --format '{{.Names}}' | grep lcm-pg
pnpm run build
LCM_TEST_CONTAINER_CLI=podman pnpm run test:postgresql            # default profile: F1-empty, F2, R3 among the PostgreSQL tests
LCM_TEST_CONTAINER_CLI=podman LCM_MIGRATION_REHEARSAL_EVIDENCE_DIR=/private/evidence \
  pnpm run test:postgresql:cutover-rehearsal                       # full profile: every generated row
```

`LCM_REHEARSAL_ONLY=F2,R3` limits a run to the named rows. The evidence directory must be an
owner-private directory outside the fixture homes; without it the rehearsal still asserts every
step and prints a bounded summary. The full profile runs one worker and takes a few tens of
minutes; the default profile adds three rows to the ordinary PostgreSQL run.

## Evidence

With `LCM_MIGRATION_REHEARSAL_EVIDENCE_DIR` set, each row writes `scenarios/<id>.json` and the run
writes `rehearsal.json`. They hold step commands, exit classes, envelope hashes, authority
checkpoints, invariant results, canonical domain digests and sealed-artifact hashes. They never hold
raw output, credentials, database URLs or message content.

[evidence-schema.json](../test/postgresql/cutover-rehearsal/evidence-schema.json) is the versioned
contract. The checker uses a small subset of JSON Schema (type, enum, const, pattern, length and
item bounds, required keys, closed objects, local references) and rejects any other keyword:

```bash
node test/postgresql/cutover-rehearsal/check-evidence.ts \
  test/postgresql/cutover-rehearsal/evidence-schema.json /private/evidence/rehearsal.json '#/$defs/rehearsal'
```

The harness cannot audit itself while it is still running. After it exits, assemble the outer
cleanup receipt and the gate record, which re-run the label-filtered Podman queries for each
allocated run id and bind the result to the tested commit:

```bash
node test/postgresql/cutover-rehearsal/assemble-gate.ts --evidence /private/evidence \
  --run-id <32-hex harness run id> --harness-exit 0 --out /private/evidence/gate.json
```

A query that fails counts as unverified, never as absent. A labelled container, network or volume
that remains makes the verdict `incomplete`.

## Verdicts

`pass`, `pass-with-documented-limits`, `fail` and `incomplete`. `pass-with-documented-limits`
means every blocking oracle passed and the row names the limit it documents (L1, F9, H2).
A limit never absorbs an unexpected failed authority, preservation, data or cleanup assertion.

## What this does not claim

- Fencing covers same-host processes of the migrating installation. It does not detect or exclude a
  second installation, another host or a direct SQLite session; see
  [Fencing residue](migration-operations.md#fencing-residue-what-this-command-group-does-not-protect-against).
  F9 and H2 record that contract and nothing more.
- Interruptions at module seams unwind a call; they are not power loss.
- A pending hook-event backlog is not drained by a migration command (see
  [No drain-liveness claim](migration-operations.md#no-drain-liveness-claim)).
- The rehearsal runs against PostgreSQL 18.4 as pinned by the harness image digests; other server
  versions are not exercised.

