# Cutover rehearsal

The cutover rehearsal drives the real built `lcm` executable through the SQLite to PostgreSQL
migration, the activation, the rollback and the faults an operator can meet in between. It runs
against an isolated PostgreSQL 18 container started by the PostgreSQL test harness and writes
sanitized evidence. It answers one question: when something is interrupted, refused or lost, is
authority still held by exactly one backend, and is every acknowledged input still there?

It is test infrastructure. It adds no command and changes no runtime behavior. The gate report for a
complete run is assembled after the full-profile run and committed on its own; until it exists, this
page describes the rehearsal and its reproduction only.

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
| I3 | Every acknowledged hook event is still retained with the same envelope. After a delivery join, each event the drain could reach has exactly one applied PostgreSQL receipt carrying the full canonical envelope (authenticated against the acknowledged digest); no event is duplicated or foreign. |
| I4 | Canonical data read independently from SQLite and PostgreSQL (per domain count and digest) matches what the row expects after activation, abort and rollback. |
| I5 | A selected PostgreSQL the operator can no longer use fails explicitly and never falls back to SQLite: the CLI reports the closed, structured permission class (not a message) and the daemon exits on its own before it is ready. A row whose manifest declares I5 not applicable records it as not applicable with that reason. The disclosure scan of every step's output is recorded as evidence, not as an I5 pass. |
| I6 | The row's private homes and owned role are removed and proved absent (a failed role drop is recorded, not suppressed), its child processes are gone, and the harness resources are audited after the harness exits. |

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
| F10 | A SQLite daemon alive across activation: `activate` and `report` answer restart-required until it is stopped; then the production replication worker, driven in process, delivers one input with its receipt captured, and the restarted PostgreSQL daemon's own start-up sweep delivers a second. |
| R3-replicated | A post-write rollback after replication uploaded an input that is still resident in the PostgreSQL inbox. |
| F11-tampered, F11-replaced, F11-partial | A damaged, replaced or partial sealed snapshot is classified, refused for resume and activation, and aborted without touching the source. |
| R1 to R6b | Rollback before activation (refused), before and after a guarded write, writers around the rollback fence, an interrupted rollback and a retry. |
| L1 | A prepared rollback selection with an out-of-band destination change: refused as drift, nothing forced (known limit, #1529). |
| S1 to S4b | Two-project cutover sets: the full forward flow and rollback, an interrupted preparation, an interrupted activation and rollback chain, member verification drift and a member install failure during rollback. |
| I5 | Selected PostgreSQL unreachable. |

Rows whose expected end state needs a product fix that is not on `main` yet carry a `gate`
field in the manifest. They are listed under `pending` in the evidence and are not generated. When
the fix is on `main`, remove the `gate` field; the row already asserts the successful end state. The
assembler derives the pending rows from the manifest and requires the recorded pending list to equal them.

A delivery join needs a receipt that survives the production prune. The daemon replicates only in its
start-up sweep and every five minutes, so the row drives the production replication worker in process
(production repositories and apply step, one pass, no retry). A proxy around the remote repository reads
the applied inbox rows immediately before the worker's prune call, so the join compares the row as
replication applied it, through the production repository's read and the production envelope comparison.
No trigger or other catalog object is added; the runtime readiness fingerprint refuses one. Where the
row requires delivery (F5-delivery, F10), one more input is acknowledged after that pass and left
undelivered; the PostgreSQL daemon then starts and its own start-up sweep must deliver it: the row waits,
bounded, until the daemon's status reports a pass that acknowledged at least one event, and requires that
input acknowledged locally against its inbox row (and pruned when the pass pruned).

Every row runs under one execution budget that cancels its administrative statements, grant swaps,
the in-process module seams that accept a signal and the harness waits; cleanup then runs on its own
bounded budget. Two boundaries cannot be cancelled precisely: an in-process module call that takes no
signal finishes its current statement first, and the harness `withPostgreSqlTestDatabase` itself.

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

Each run also records, when it starts and again when it ends, the tested commit, whether the tree was dirty,
a digest of the tracked inputs (every tracked path except the two gate files), the lockfile digest and the
digest of the built `dist/lcm.mjs`, together with the container runtime and harness run id it executed under.
A run whose inputs or CLI changed while it ran, or whose tree was dirty, cannot become a complete gate.

The harness cannot audit itself while it is still running. After it exits, assemble the outer cleanup
receipt and the gate record. Name the container runtime explicitly (there is no default) and pass the
harness run id the run printed (`PostgreSQL harness allocated run: <id>`):

```bash
LCM_TEST_CONTAINER_CLI=podman node test/postgresql/cutover-rehearsal/assemble-gate.ts \
  --evidence /private/evidence --run-id <32-hex harness run id> --harness-exit 0 --out /private/evidence/gate.json
```

The assembler re-checks the evidence instead of trusting its verdicts. It requires every row's required
invariants to have passed and every authority checkpoint to agree with the manifest; the full profile,
no row filter, no pending row and exactly the checked-in manifest's full-profile rows; the run id and
runtime that executed the run; a checkout and CLI that still match the run's recorded witnesses; the
label-filtered container, network and volume queries for the run id (a query that fails counts as
unverified, never as absent); the private home roots and recorded child processes being gone; and the
pinned database image digest. Anything missing makes the verdict `incomplete`; a failed row makes it `fail`.

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

