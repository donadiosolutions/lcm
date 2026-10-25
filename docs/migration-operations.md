# Migration Operations: SQLite to PostgreSQL Cutover

This document is the operator runbook for the `lcm migration` command group, which performs a
reversible, in-place cutover of an LCM installation from its local SQLite storage to a configured
PostgreSQL destination. Read this in full before running `apply` against a project you care about.

## Before you run `apply`: what it actually does to your installation

**`apply` puts your installation into a maintenance hold that only `activate` or `abort` can
leave.** This is the single most important fact in this document, and it is stated here, first,
because an operator who runs `apply` expecting it to be one step in a longer sequence needs to know
before running it, not after.

A successful `apply` captures your SQLite data, mints a migration manifest, and copies the captured
data to the configured PostgreSQL destination. It does this under a maintenance hold on your local
installation. That hold is not released when `apply` finishes. While the hold is held, ordinary LCM
storage operations on this installation — hook writes, memory search, compaction, anything that
touches local storage as a consumer — are fenced and will refuse or retry rather than proceed.

The cutover is a sequence, and every step is its own command:

```text
plan -> apply -> resume (until copied) -> verify -> activate -> swap the grants -> start the daemon
                       \-> abort   (before activation: leaves the hold, discards the attempt)
activated generation -> rollback   (returns to SQLite)
```

`lcm migration report` names the command that owns the state you are in; run it between steps. All
nine commands are registered: `plan`, `dry-run`, `apply`, `resume`, `verify`, `report`, `abort`,
`activate` and `rollback`.

- **`activate` completes the cutover.** It switches the installation to the copied PostgreSQL data
  and releases the hold. It runs entirely under the PostgreSQL **transfer role**, so after it
  succeeds you must swap the grants **before starting the daemon**: add the runtime grants to the
  daemon's runtime role, then revoke the transfer grants. See "The cutover: activate and the grant
  swap" below.
- **`abort` leaves the hold before activation.** It discards the hold and the captured snapshot's
  standing and returns your installation to normal, unfenced SQLite operation. Nothing about your
  PostgreSQL destination is affected by `abort`; the copy, if it reached PostgreSQL, is simply not
  used.
- **`rollback` returns an activated generation to SQLite.** It refuses while any other project is
  remotely bound; see "Rollback and its limits".

If you need your installation to keep operating normally in the meantime, either do not run `apply`
yet, or run `abort` immediately afterward once you have confirmed what you needed to confirm.

## Configuration: `storage.backend` versus `storage.postgresql`

`storage.backend` in `config.json` names which backend is **active** for ordinary LCM operation —
currently `sqlite` for any installation that has not completed a cutover. `storage.postgresql`
(plus its `LCM_POSTGRES_URL` / `LCM_POSTGRES_CA_FILE` / `LCM_POSTGRES_MIGRATION_ROLE` environment
fallbacks) names **how to reach PostgreSQL** as a migration destination. Migration commands read
the latter regardless of what the former says — `storage.backend` staying `sqlite` for the whole
duration of `plan`, `dry-run` and `apply` is expected and correct, not a sign that anything is
misconfigured.

`storage.postgresql.url` and `storage.postgresql.caFile` must not be written into `config.json`
directly; the ordinary (non-migration) configuration loader refuses a stored secret there by
design. Supply them through the `LCM_POSTGRES_URL` and `LCM_POSTGRES_CA_FILE` environment variables
instead. `storage.postgresql.migrationRole` (or its `LCM_POSTGRES_MIGRATION_ROLE` fallback) may be
set in either place.

Your project must not be linked to a PostgreSQL project through `lcm project create` or
`lcm project link` before running migration commands. Migration resolves (and, on first use, mints)
its own destination project identity directly against PostgreSQL; the local project-to-project
binding those commands create is reserved for later activation and, if already set, will make
capture refuse (`multi-machine-installation`) rather than proceed.

## Commands

Every command accepts `--json`, which prints exactly one JSON document to stdout (see
"The JSON envelope" below) and sends progress and human-readable text to stderr instead. Without
`--json`, a short human-readable summary line goes to stdout; progress still goes to stderr either
way.

**Which command next.** Run `lcm migration report` first: it names the cell your installation is in
(see "State routing" below) and the command that owns it. `resume`, `verify`, `abort`, `activate` and
`rollback` act on one generation, the live maintenance hold's by default. A hold that has already
ended names no generation, so pass `--generation <id>` (`abort` and `report` use the journal's own
generation). A mutating command also needs `--confirm-generation <id>`, equal to the generation it
resolved; an omitted or different id refuses exit 3 with the home byte-identical, and the refusal
reports the id to pass. If the generation's state belongs to another command the refusal names it
(exit 2), or names `resume`/`verify` when a begun effect only that command can finish (exit 6).

**`--confirm-backend`.** `activate` and `rollback` also need `--confirm-backend`. `activate` compares
it with the backend the manifest says the generation switches to, `postgresql`; `rollback` compares
it with the backend the manifest says it came from, `sqlite`. The manifest invariant makes each of
those the only legal value, so the fence confirms that you meant the switch; it does not detect
that you were about to go the wrong way. An omitted value refuses `backend-confirmation-missing`
and a different one `backend-confirmation-moved` (both exit 3, nothing changed).

**What `--dry-run` promises.** No migration state is written: not the journal, the manifest, the
report store, the project map, or PostgreSQL project and alias rows. Coordination effects are
listed in the envelope's `evidence.coordinationEffects` and are allowed only where this table lists
them:

| Command | Coordination effects of `--dry-run` |
| --- | --- |
| `plan`, `apply` | read the candidate under the source append barrier |
| `verify` (fresh, cell 22) | takes and releases the verification lease (`lcm.fenced_leases`) and takes the source append barrier |
| `verify` (cells 23, 24), `resume`, `abort`, `activate`, `rollback` | none |

`resume --dry-run` is route-only and `verify --dry-run` at a pending effect is too: they name the step
and set `predictive: false`, because completing the step is what performs the checks. `activate
--dry-run` and `rollback --dry-run` are never predictive and **never exit 0**: they say what they read
and what they did not evaluate, and exit 5. A preview that could not evaluate the checks that decide
the outcome must not read as a yes.

### `lcm migration plan [--json]`

Non-mutating. Checks every precondition `apply` will check — target configuration, PostgreSQL
reachability and TLS/role verification, daemon presence, and the candidate migration generation —
and prints the result without taking any hold, capturing anything, or writing anything. Run this
first. Its printed generation id is the exact value `apply --confirm-generation` must be given.

Identity is previewed, never minted: the evidence says whether the destination project `exists` or
`will-be-created-at-apply`, and whether the local project map entry is `persisted`. Only `apply`,
after its confirmation fence, writes either.

Exit 0 postcondition: every precondition read succeeded and the emitted evidence is complete,
including a positively established daemon-presence answer and a computed candidate generation id.

### `lcm migration dry-run [--json]`

Non-mutating, and deliberately narrower than `plan`: it checks only that the local SQLite source
can be read and classified for capture. It does not resolve a destination, does not take a hold,
and does not touch the maintenance journal. Use it to check the SQLite side alone, independent of
PostgreSQL reachability or daemon state.

Exit 0 postcondition: the dry-run completed and its result was read back.

### `lcm migration apply --confirm-generation <id> [--dry-run] [--max-records <n>] [--max-bytes <n>] [--json]`

Mutating (unless `--dry-run` is given). The entry point: resolves the same preconditions `plan`
checks, confirms `--confirm-generation` against a freshly re-resolved candidate id, takes the
maintenance hold, captures the SQLite source, mints the migration manifest, and copies the captured
data to PostgreSQL in batches bounded by `--max-records` and `--max-bytes` (both optional; sane
defaults apply).

`--confirm-generation <id>` is required in practice, though not enforced at the command-line
parsing level: omitting it reaches the same confirmation-fence refusal (`confirmation-missing`,
exit 3) that a stale or wrong id reaches, rather than a generic usage error, so the operator always
sees the same closed vocabulary regardless of how the token went missing. The id must come from a
`plan` run against the same project state; if the candidate generation moved between `plan` and
`apply` (because local state changed), `apply` refuses `confirmation-generation-moved` (exit 3)
rather than silently applying against a different generation.

**Nothing is written before that fence.** The local project map entry and the destination
PostgreSQL project and alias rows are created only after `--confirm-generation` matches, inside the
capture span and after that span's own re-check of the confirmed candidate against the live state,
so `confirmation-generation-moved` never leaves identity behind; a missing or mismatched token
leaves them, and the home, as they were. A refusal that can still follow the mint (a failed hold
entry, a capture, genesis or copy failure, or an unclassified throw) carries what the identity
step actually did in its evidence: `localProject` is `minted` (written by this run), `persisted`
(already there, reused), `not-persisted` or `unknown`; `destinationProject` is `created`,
`exists` (reused, including a concurrent creator's row), `not-created` or `unknown` (the step
threw before that stage could report, so its outcome is not known). `applied` is `true` whenever a
stage reports a real write. On the next `apply`, a minted local entry is read as persisted, and
the destination is read as present only when the evidence said `created` or `exists`; otherwise
that run creates it (or reuses whatever an interrupted write left, which `plan` previews as
`exists`). While a hold exists, `apply` never
creates either: it reads the persisted local identity and selects the destination project, and
refuses `local-identity-not-persisted` or `destination-project-absent` (exit 5) rather than
mint under a hold. Run every command on an existing generation from the migrated project's
directory: the persisted identity is read from the current directory, so another directory reports
`local-identity-not-persisted`.

`--dry-run` stops immediately after the confirmation fence, before the hold is taken or anything is
captured. The emitted envelope reports the confirmed candidate with `applied: false`.

Exit 0 postcondition: the maintenance journal re-reads at the expected phase and checksum; the
captured snapshot classifies `complete`; the manifest head is read back and reads at the expected
phase (`copied`) -- the phase the envelope reports is the one read, not the copy layer's own report.

**Read "Before you run apply" above before using this command for real.**

### `lcm migration resume [--generation <id>] --confirm-generation <id> [--dry-run] [--max-records <n>] [--max-bytes <n>] [--json]`

Mutating (unless `--dry-run` is given). Runs the one step the router gives `resume` for a held
generation and stops at the next durable checkpoint; it never chains into the following step. Run it
again, or follow `report`'s `next`, to continue.

| Cell | State | What `resume` runs |
| --- | --- | --- |
| 19 | manifest `planned`, nothing pending | begins and completes the dry-run effect (contacts PostgreSQL), reading `dry-run-verified` back |
| 20 | pending dry-run effect | completes that carried effect only; a different effect id writes nothing |
| 21 | `dry-run-verified` or `copying`, or a pending copy effect | the copy only, stopping at `copied` |
| 23 | pending verification effect | completes it from the persisted report, as `verify` does (no PostgreSQL) |
| 6 | journal aborted, pending abort effect | completes the carried abort effect, as `abort` does |
| 11 | activation re-entry (a begun `activate`) | runs `activate` again: the same call, the same outcome table |
| 12 | rollback re-entry (a begun `rollback`) | runs `rollback` again: the same call, the same outcome table |

At cells 11 and 12 `resume --confirm-generation` is the fence; the backend literal `activate` and
`rollback` ask for is read from the manifest, because the re-entry of a cutover that has already
begun has no direction left to confirm. The outcome, including the restart observation and the
grant-swap instruction, is the one `activate` or `rollback` would have printed, under `resume`'s
name.

The destination identity is the held one: the persisted local project identity and a read of the
existing destination project. `resume` never creates either. `--dry-run` names the cell and runs
nothing: it calls no step, takes no lease or barrier, claims no prediction (`predictive: false`),
and exits 0 when routing itself succeeded.

Exit 0 postcondition: the manifest was read back at the checkpoint the cell produces.

### `lcm migration verify [--generation <id>] --confirm-generation <id> [--dry-run] [--lease-ttl-ms <n>] [--json]`

Mutating (unless `--dry-run` is given or the generation is already verified).

- **Pending verification** (cell 23): completes it from the persisted, activation-eligible report.
  This never reopens PostgreSQL, so it works with the destination down. It refuses
  `verify-report-identity-conflict` when the pending effect does not name that report and
  `verify-destination-drift` when the report does not match the destination the copy sealed; both
  exit 5 with nothing written.
- **Already verified** (cell 24): confirms from the persisted report and writes nothing.
- **Copied, nothing pending** (cell 22): the fresh verification. It needs the maintenance hold to
  be held for this generation and it opens PostgreSQL. Every input comes from something that
  already exists: the destination connection, migration role and project identity from the
  configuration and the persisted identity (the same resolution `activate` uses); the sealed
  destination digests and cluster identifier from the manifest; the queue-classification witness
  from the captured snapshot's receipt reference; and the project-map witness from the project map.
  A manifest that never recorded the destination's cluster identifier refuses
  `verify-destination-drift`; nothing is invented in its place. It takes the verification lease
  (`--lease-ttl-ms`, default 300000) and the source append barrier; contention for either, or
  losing the lease, refuses `verify-contention` (exit 4) with no effect begun, and running it again
  recomputes. A report with mismatches or incomplete coverage is kept as evidence, the generation
  stays `copied`, and `verify` refuses `verify-not-eligible` (exit 5). `--dry-run` runs the same
  computation and records nothing, taking and releasing the lease; it exits 0 only for a report that
  would be eligible. `abort` remains available from this cell.

`verify` never exits 6: it finishes its own pending effect.

Exit 0 postcondition: the manifest reads `verified` with nothing pending and its verification report
reference names a persisted, activation-eligible report. The next command is `activate`.

### `lcm migration report [--generation <id>] [--json]`

Read-only. It takes no lock, barrier or lease, runs no preflight and writes nothing, so it is safe to
run at any time, including while another command works. It prints, as ids, digests, phases and
booleans only: the journal and its phase, the snapshot class, the manifest phase, revision and
pending effect, the verification report summary (clean, eligible, mismatch total, coverage), the
router cell and `next`, the activation and rollback evidence below, and — when a selection is
already durable — the daemon restart check.

The activation and rollback evidence is read with lock-free, three-valued readers, and each is
shown as `present`, `absent` or `unresolvable`: the activation link, the activation report the
manifest names, the generation bindings, the activation epoch, attempt and witness store
(`rollbackEvidence`), the rollback report the manifest names, and the rollback authority artifact. A
reader that could not answer, a report the manifest names that is missing, or a verification report
the manifest references that cannot be read (shown as `unreadable`), is shown as such and makes the
report exit 5 (`report-evidence-unresolvable`); an unresolvable entry is never read as absence.

A non-zero exit still prints everything it read: 2 when no generation can be resolved, 4 for a
foreign publication in flight, 5 for contradictory or unreadable evidence (including either restart
observation failing), 8 when only a daemon restart is outstanding.

Exit 0 postcondition: every reader was read and no contradiction was found.

### `lcm migration abort [--generation <id>] --confirm-generation <id> [--dry-run] [--json]`

Mutating (unless `--dry-run` is given). Leaves a maintenance hold before activation.
Classifies the live maintenance journal and the manifest first, and only then completes whichever
of the journal termination and the manifest settlement is still outstanding. Discards the captured
snapshot's standing as a migration-in-progress; nothing on the PostgreSQL side is deleted or undone,
since `abort` never reaches PostgreSQL at all. `--generation` defaults to the journal's own, live or
already terminal.

**Repeating `abort` only confirms.** When the journal is already `maintenance-aborted` and the
manifest is absent or aborted, `abort` writes nothing, exits 0 with `applied: false`, and reads the
settled pair back. A crash between the two writes is finished by running `abort` again: with the
journal aborted and the manifest copied, planned or similar, it settles the manifest; with the abort
effect already begun, it completes that carried effect without aborting the journal a second time.

`abort` writes nothing unless it can finish the whole recovery. A manifest with a begun effect that
`resume` (or `verify`) owns — a pending copy, dry-run or verification effect — is refused
`route-resume-required` (exit 6, `next` names the command) while the hold is still intact, rather
than releasing the hold and leaving a manifest nothing can settle. `abort` settles both sides from
`planned`, `dry-run-verified`, `copying` and `copied` (nothing pending) and from a hold with no
manifest yet. An aborted journal beside a pending copy effect is `route-operator-required` (exit 7).
A pending effect that appears after `abort`'s first route is classified again, with one of three
outcomes: exit 6 naming `resume` when `resume` may run it; otherwise the router's refusal for the new
state (for example exit 7, operator required); or `abort-journal-moved` with no `next` when `abort` is
still admitted, in which case re-run `abort`.

`--confirm-generation <id>` must equal the generation id of the journal. Omitting it refuses
`abort-confirmation-missing` and a different id refuses `abort-confirmation-moved` (both exit 3,
nothing changed); either refusal reports the generation id in its `generation` field, so you can
re-run with it. `--dry-run` runs every read and check, reports `applied: false`, and changes
nothing; it still requires the token and refuses with the class the real run would get.

Exit 0 postcondition: the maintenance journal reads terminal and the manifest reads settled, both
read back after the operation, not assumed from the operation reporting success.

### `lcm migration activate [--generation <id>] --confirm-generation <id> --confirm-backend postgresql [--dry-run] [--json]`

Mutating. Switches a verified generation to PostgreSQL and releases the maintenance hold. It owns
cell 24 (held, `verified`), cell 11 (an activation that was begun and not finished) and the settled
re-entry at cell 10 (the generation's own completed publication and an `active` manifest). It adds no
algorithm of its own: it supplies the inputs the activation orchestration asks for and maps what it
returns.

**Inputs.** The PostgreSQL connection is the transfer-role connection that `verify` opens, resolved
from `storage.postgresql` and its environment fallbacks, and it is passed as **both** of activation's
settings, because activation runs entirely under the transfer role. The expected owner is the
configured migration role and the expected identity is the persisted local identity with a read of
the destination project. Nothing is written to `config.json`, and an input that cannot be resolved
refuses before the call.

**Fences.** `--confirm-generation` and `--confirm-backend postgresql` (see "Commands" above).

**What it returns, and the exit it gets.**

| Outcome | Exit | Meaning and next step |
| --- | --- | --- |
| activated, restart cell satisfied | 0 | The manifest reads `active` with nothing pending, the result names this generation, and no daemon holds a stale backend. **Next: swap the grants, then start the daemon.** |
| activated, a running daemon holds the previous backend | 8 | The selection is durable and correct. Swap the grants, restart the daemon, run `report`. |
| activated, the restart check and the presence observation disagree or cannot be made | 5 | `cutover-restart-contradiction` / `cutover-restart-unresolvable`. Run `lcm daemon status`, resolve it, run `report`. |
| refused before any effect | 2, 4, 5 or 6 | `activation-refused-precondition` (2), `-contention` (4), `-evidence` (5), `-resume` (6); the evidence names the step (`S0`-`S8`) and the reason. Nothing changed. |
| interrupted after an effect began | 6 | `activation-interrupted`. Run `activate` again with the same confirmations. The evidence names the step, the cause, what is known to have been applied and whether the report was stored. |
| interrupted before any effect | 2 | `activation-not-begun`. The manifest is unchanged; run `activate` again. A lease it took is not claimed to be released: it expires after 15 minutes or the next run takes it over. |
| the publication did not complete | 5 | `activation-publication-failed`; the evidence names its status. |
| published but the target is not healthy | 5 | `activation-post-publication-unhealthy`. The cutover is **not** complete. Fix the target, then run `activate` again. |
| a result for another generation, or one the manifest does not read back | 5 | `activation-identity-mismatch`, `activation-readback-mismatch`. Nothing is accepted as success. |
| a thrown error | 5 | `activation-invalid-input`, `activation-unexpected-state`, or `unexpected-failure`. Never success and never exit 6. |

The refusal classes by reason (each reason has exactly one): **exit 2** `manifest-absent`,
`manifest-not-eligible`, `maintenance-not-held`, `quiescence-unsatisfied`, `coverage-unsatisfied`,
`uncovered-projects` (a machine with stored data for more than one project is out of scope here),
`verification-stale`, `identity-drift`, `project-map-drift`, `target-unhealthy`, `census-drift`,
`class-coverage-incomplete`, `verification-mismatch`; **exit 4** `lease-conflict`; **exit 5**
`manifest-unresolvable`, `maintenance-unresolvable`, `lease-unresolvable`, `quiescence-unresolvable`,
`coverage-unresolvable`, `verification-unresolvable`, `target-unresolvable`, `evidence-unresolvable`,
`state-unresolvable`; **exit 6** `pending-effect-foreign` when `resume` owns that pending effect, exit 2
otherwise. A failed best-effort release of the lease is shown as `leaseReleaseFailed` in the
evidence and nothing more.

**`--dry-run`** reads the persisted state (the manifest, the verification report, the journals, the
link, the artifact and the restart check) and lists `notEvaluated`: quiescence, coverage, the
project-coverage refusal, the lease, target health and the census. Those are the checks that decide
an activation, so the preview can never say it would succeed: it always refuses
`activation-dry-run-not-predictive` (exit 5). No coordination effect is taken.

**Grants.** Activation runs under the transfer role and never touches grants. After exit 0, swap the
grants before starting the daemon: add the runtime grants to the daemon's runtime role, then revoke
the transfer grants (the steps are in "The cutover: activate and the grant swap"). #1607 is the
later improvement that will let the daemon's readiness admit the transfer role.

**After the grant swap, use `report`, not `activate`.** `activate` runs under the transfer role and
the swap revokes that role's grants, so a repeat is not meant to be run once the swap is done.
`lcm migration report` reads the settled state without a connection.

Exit 0 postcondition: the manifest reads `active` with nothing pending, the identity the call
returned is the confirmed generation's, and the restart cell is satisfied (a restart verdict of
satisfied, with the daemon absent or already on `postgresql`).

### `lcm migration rollback [--generation <id>] --confirm-generation <id> --confirm-backend sqlite [--dry-run] [--json]`

Mutating. Returns an activated generation to SQLite. It owns cell 12 (a rollback that was begun and
not finished) and is allowed at cell 10 (`active`), cell 13 (`rolled-back`; running it again is the
settled re-entry) and cell 24 (a verified generation that never activated). It decides nothing
itself: eligibility, the rollback mode (`pre-write` or `post-write`), the quiescence check and the
remote-binding refusal all belong to the rollback orchestration, which re-enters every interrupted
state. **Rollback refuses while any other project is remotely bound**, because the backend selection
is global (see "Rollback and its limits").

**Fences.** `--confirm-generation` and `--confirm-backend sqlite`.

| Outcome | Exit | Meaning and next step |
| --- | --- | --- |
| manifest `rolled-back`, nothing pending, read back; restart cell satisfied | 0 | The envelope carries the mode, the eligibility and the report. |
| rolled back, a running daemon holds the previous backend | 8 | Restart the daemon, run `report`. |
| rolled back, the restart check and presence disagree or cannot be made | 5 | `cutover-restart-contradiction` / `cutover-restart-unresolvable`. |
| returned at another phase (the interrupted publication could not be proven complete and was abandoned) | 2 | `rollback-abandoned`, with the abandonment report. Nothing was rolled back and no restart check ran; run `rollback` again. |
| a result the manifest does not read back as `rolled-back` | 5 | `rollback-readback-mismatch`. |
| not eligible, or not quiescent | 2 | `rollback-refused-precondition`; the evidence names `not-eligible` or `quiescence-unsatisfied`. |
| the rollback lease was lost or is held elsewhere | 4 | `rollback-contention`. Run `rollback` again; it re-enters what was begun. |
| unresolvable evidence, drift, unresolvable inputs, unexpected state | 5 | `rollback-refused-evidence`; the evidence names `unresolvable`, `drift`, `input-unresolvable` or `unexpected-state`. |
| any other thrown error | 5 | `unexpected-failure`. |

`applied` is reported `true` for a refusal only when the manifest is read back changed (or cannot be
read), so it does not claim a write that did not happen.

**`--dry-run`** reads the route and the manifest only; it does not call the rollback orchestration
to discover a mode. It lists `notEvaluated`: eligibility, mode, quiescence, lease, drift,
remote-binding and restart, and exits 5 (`rollback-dry-run-not-predictive`).

Exit 0 postcondition: the manifest reads `rolled-back` with nothing pending for the confirmed
generation, read back from disk, and the SQLite restart cell is satisfied.

## What every command can refuse, and what to do about it

Every refusal names a closed reason string, an exit class (below), and a static remedy —
never a raw driver error message, a file path, or anything else that could vary between runs of the
same underlying condition. The complete, machine-checked table (identical to what the CLI itself
consults) is in "Machine-readable inventory" at the end of this document; the entries most worth
knowing by name:

- `confirmation-missing` / `confirmation-generation-moved` (exit 3): re-run `plan` and pass its
  printed id. `apply` checks the id twice: against its preflight, and again inside the capture step
  immediately before it takes the hold. If another local actor occupied your candidate generation
  in between, the second check refuses `confirmation-generation-moved` and nothing is written.
- `hold-entry-contention` / `hold-entry-slot-occupied` (exit 4), `hold-entry-precondition`
  (exit 2), `hold-entry-evidence` (exit 5): the maintenance hold was **not** entered, so there is
  nothing of yours to `abort`. Wait for the other actor, or re-run `plan`, or run `lcm doctor`,
  as the remedy says.
- `capture-contention` (exit 4) / `capture-unresolvable` (exit 5): capture was interrupted after the
  hold was taken. The hold is still in place; re-run `apply` with the same `--confirm-generation` to
  continue, or `abort` to release it. `capture-failed` (exit 7) is reserved for capture's own
  failures.
- `continuation-partial-snapshot` (exit 2): a held generation whose snapshot is partial or replaced
  cannot be continued. `abort` is the only command that applies.
- `daemon-presence-unresolvable` (exit 5): `apply` could not positively determine whether a daemon
  is running. Run `lcm daemon status`, resolve the failure, and retry. A daemon that genuinely is
  not running is **not** a refusal here — see "Daemon presence" below.
- `multi-machine-installation` (exit 2): this project is already linked to a PostgreSQL project
  (see "Configuration" above). Migration requires an unlinked, single-machine project.
- `route-not-owner` (exit 2), `route-resume-required` (exit 6), `route-publication-in-flight` (exit 4),
  `route-operator-required` (exit 7),
  `route-unresolvable` / `route-foreign-publication` / `route-contradiction` (exit 5): the router
  looked at the journal, manifest and snapshot of the generation and this command does not own that
  cell. The envelope's `next` names the command that does, when one does. Nothing was changed.
- `existing-confirmation-missing` / `existing-confirmation-moved` (exit 3): `resume`, `verify`,
  `activate` or `rollback` was not given the resolved generation id. The refusal reports it in
  `generation`. `backend-confirmation-missing` / `backend-confirmation-moved` (exit 3) are the same for
  `--confirm-backend`.
- `activation-*` and `rollback-*` (exits 2, 4, 5, 6): the closed outcome tables of `activate` and
  `rollback`, in their command sections above. `cutover-restart-required` (exit 8) is the one
  that means the cutover is durable and a running daemon still holds the previous backend; swap the
  grants if you have not, restart the daemon, and run `report`. `cutover-restart-contradiction` and
  `cutover-restart-unresolvable` (exit 5) mean the two restart observations could not be trusted.
- `verify-contention` (exit 4): the verification lease or the source append barrier is held
  elsewhere, or the lease was lost; no effect was begun. `verify-not-eligible` (exit 5): the fresh
  verification found mismatches or incomplete coverage; the report is kept and the generation stays
  `copied`. `verify-project-map-drift` / `verify-project-map-unresolvable` (exit 5): the project map
  does not match, or cannot be read for, the verification witness.
- `report-evidence-unresolvable` (exit 5): a reader of the activation or rollback evidence could not
  answer, or a report the manifest names is missing or (verification) unreadable; the report still
  prints what it read.
- `generation-required` / `generation-unknown` (exit 2), `generation-invalid` (exit 1): pass
  `--generation` naming a generation that exists.
- `abort-nothing-to-abort` (exit 2): there is no hold to leave. Nothing to do.
- `unexpected-failure` (exit 5): something threw that no command classified. The command still prints
  exactly one envelope; its evidence is only the error's name. Check `applied` (reported `true` for
  every command that can write, which cannot rule out an earlier write), run `lcm doctor`, and re-run
  `lcm migration plan` to see the current state.
- Anything ending `-unresolvable` or classed `refused-evidence` (exit 5): the command could not
  establish the state it needed to decide anything — this is different from the state actively
  forbidding the operation (exit 2), and the remedy is almost always `lcm doctor` followed by a
  retry.
- Anything classed `failed-operator-required` (exit 7): no automatic path resolves this. Some of
  these mean nothing was mutated (an internal defect in a generated identifier, for example);
  others mean a mutation already happened and is durable (a capture or copy failure after the hold
  was taken). The JSON envelope's `applied` field says which — check it before assuming either way.
  File an issue rather than retrying blindly.

## The exit classes

Nine classes, closed, never reused for a different meaning. Exit 0 always carries a positively
read-back postcondition (named per command above); a command never returns 0 merely because nothing
threw. Exit 5 ("I could not establish the state") is distinct from exit 2 ("I established the
state and it forbids this") -- they call for different operator responses, and conflating them
would tell an operator a definite "no" when the honest answer was "unknown".

| Code | Class | Meaning |
| --- | --- | --- |
| 0 | `ok` | Completed and its named postcondition was positively read back |
| 1 | `usage` | Malformed invocation. Never reaches a storage seam |
| 2 | `refused-precondition` | State does not admit this operation. Remedy names the command that does |
| 3 | `refused-confirmation` | A mutating boundary was not confirmed |
| 4 | `refused-contention` | Another actor holds the lock, barrier or lease |
| 5 | `refused-evidence` | Evidence is absent, unattributable, or failed its comparison |
| 6 | `incomplete-recoverable` | Durably begun, not terminal, and a re-run can finish it: `resume` (or `verify`) for a pending effect, `activate` for an interrupted activation. A command that is not the owner of the cell exits 6, naming the one that is |
| 7 | `failed-operator-required` | No automatic path resolves this; a human must decide. Check `applied` for whether anything mutated |
| 8 | `restart-required` | Durable state correct; a live daemon holds a stale startup backend; `report`, `activate` and `rollback` exit 8 (see "Restarting the daemon after a selection") |

## The JSON envelope

With `--json`, every command prints exactly one document, written once at the end, with these eleven
fields in this order. The set is frozen for `schemaVersion` 1; an addition would bump it.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | always `1` |
| `command` | the command that ran |
| `outcome` | the exit class name (see "The exit classes") |
| `exitCode` | the exit code; always the code of `outcome` |
| `generation` | the generation the command resolved, or `null` |
| `manifestPhase` | the manifest phase the command read or produced, or `null` |
| `applied` | `true` only when the command durably wrote something in this run, including before a refusal |
| `next` | the command (or operator step) to run next, or `null` |
| `evidence` | a flat map of ids, digests, phases, counts and booleans. Never a path, a URL, a message or a secret |
| `refusal` | `null` on exit 0; otherwise `{ reason, remedy }`, a closed reason and static remedy text |
| `restart` | the restart observation (`answer` and `presence`) for `report`, `activate` and `rollback`, or `null` |

Evidence is checked before it is printed, on exit 0 as well as on a refusal: a value that looks like
an absolute path or a credentialed URL, or is longer than 256 characters, makes the command print
the closed `unexpected-failure` instead of leaking it. The refusal reasons are in "Machine-readable
inventory"; each carries its exit class and its remedy.

## State routing: which command owns which situation

This table exists so that every state your installation can be in has exactly one command that
owns getting you out of it. `report` prints the cell number and `next`; every command that is not
the owner refuses naming it (exit 2), or exit 6 when a begun effect only the owner can finish is
pending. A non-owner at cell 11 exits 6 when an activation effect is pending and 2 otherwise; at
cell 12 it exits 6. The same router decides for all of them, so they cannot disagree.

| Cell | Maintenance journal | Snapshot | Manifest | Owner | Also allowed |
| --- | --- | --- | --- | --- | --- |
| 14-16 | `entering`/`held`, matching | absent or complete | absent | `apply` (recovers, continues, mints the manifest and copies) | `abort` |
| 17 | `entering`/`held`, matching | `partial`, `replaced`, `tampered` | absent, or nothing pending | **`abort` only** | -- |
| 18 | `entering`/`held`, matching | `partial`, `replaced`, `tampered` | an effect is pending | none -- exit 7, evidence preserved | -- |
| 19 | `held` | complete | `planned` | `resume` | `abort` |
| 20 | `held` | complete | pending dry-run effect | `resume` | -- |
| 21 | `held` | complete | `dry-run-verified`/`copying`, or a pending copy effect | `resume` | `abort` only with nothing pending |
| 22 | `held` | complete | `copied` | `verify` (fresh computation) | `abort` |
| 23 | `held` | any | pending verification effect | `verify` | `resume` |
| 24 | `held` | complete | `verified` | `activate` | `verify` (confirms), `rollback`, `abort` |
| 4 | `entering`/`held`, another generation | any | any | `abort` (acts on that live hold) | -- |
| 5 | `maintenance-aborted` | any | absent or `aborted` | none -- settled; `apply` starts a fresh cutover | `abort` (confirms only) |
| 6 | `maintenance-aborted` | any | pending abort effect | `abort` | `resume` |
| 7 | `maintenance-aborted` | any | pending copy, dry-run or verification effect | none -- exit 7 | -- |
| 8 | `maintenance-aborted` | any | begun-nothing phase before `verified` | `abort` (settles the manifest) | -- |
| 9 | `maintenance-aborted` | any | anything else | none -- exit 5; `abort` is never called | -- |
| 10 | the generation's own completed publication | any | `active`, nothing pending | none -- settled; `report` | `activate` (settled re-entry), `rollback` |
| 11 | the generation's own publication in flight or aborted, or a `selection-prepared`/`selection-completed` hold | any | `verified`, `activating`, or a pending activation effect | `activate` | `resume` |
| 12 | not aborted | any | `rolling-back`, or a pending rollback effect | `rollback` | `resume` |
| 13 | not aborted | any | `rolled-back`, nothing pending | none -- settled; `report` | `rollback` (settled re-entry) |
| 2, 3 | a v2 publication | any | any | none -- exit 4 while in flight, exit 5 when foreign and finished | -- |
| 1, 25 | unresolvable, or no row matches | -- | -- | none -- exit 5 | -- |

A generation classifying `partial` or `replaced` is **never deleted**. Every failed or abandoned
capture attempt is preserved on disk exactly as-is; `abort` releases the hold without touching that
evidence. Nothing this command group does removes a generation's captured artifacts. Each aborted-
after-capture attempt does, however, permanently consume one probe ordinal for this project's base
identity -- retrying after `abort` computes a fresh, later ordinal rather than reusing the aborted
one, so a project that aborts many attempts will see its candidate generation numbers climb; this is
expected and not a sign of a leak.

## The cutover: activate and the grant swap

Once `verify` has left the generation `verified`, the cutover finishes in this order. Do not reorder
it.

1. `lcm migration activate --confirm-generation <id> --confirm-backend postgresql`. It runs under the
   transfer role and, on exit 0, the selection is durable and the hold is released.
2. **Swap the grants, before starting the daemon.** Activation proves that the transfer role could publish the selection; it does
   not prove that the daemon can start, because the daemon enforces its exact runtime privilege
   profile when it starts and that profile rejects the transfer grants. Add the reviewed runtime
   grants to the daemon's runtime role, then revoke the transfer grants from the transfer role (or
   drop it), so the runtime role is the schema's only non-owner grantee. Applying the runtime grants
   before revoking the transfer grants is harmless, because readiness is evaluated only when the
   daemon starts. The scripts and the procedure are in
   [Migration cutover: after activation](migration-cutover.md#after-activation-the-grant-swap-and-the-daemon).
   A later improvement, #1607, will let the daemon's readiness admit the transfer role next to the
   runtime role; until then the swap is your step.
3. Start (or restart) the daemon. It performs its own readiness check against the runtime role and
   refuses to serve until it passes.
4. Run `lcm migration report` until it exits 0 (see "Restarting the daemon after a selection").

Between steps 2 and 3, change the connection in the shell and service environment you will use from
here on: `LCM_POSTGRES_URL` must name the daemon's **runtime role** (activation used the transfer
role's URL), and `storage.postgresql.migrationRole` stays the schema owner. Both the daemon and a
later `rollback` read these settings.

`activate` prints the swap as its next step on exit 0 (`next` is `swap-grants-then-start-daemon` and
the evidence carries `grantSwap: required-before-daemon-start`), and its exit 8 refusal repeats it.

## Rollback and its limits

`lcm migration rollback` returns an activated generation to SQLite: an exact reversal of the
selection with no data copy when nothing was written to PostgreSQL after activation (`pre-write`),
and a reconstruction from PostgreSQL otherwise (`post-write`). The mode is classified by the
rollback orchestration and reported, never chosen by the CLI.

**Rollback refuses while any other project is remotely bound.** The backend selection is global to
the installation, so unwinding it for one project would also switch every other project that is
bound to PostgreSQL back to SQLite. The refusal arrives as `rollback-refused-precondition` or
`rollback-refused-evidence` (the evidence names `not-eligible` or `drift`), and the CLI neither
pre-checks nor softens it. Moving several projects at once is separate, planned work (#1544);
`activate` likewise refuses a machine that has stored data for more than one project
(`uncovered-projects`).

**Which role it connects as.** `rollback` opens PostgreSQL with the configured `storage.postgresql`
settings and holds them to the daemon's readiness rules, so it is meant to run after the grant swap,
as the runtime role: set `LCM_POSTGRES_URL` to the runtime role's connection and keep
`migrationRole` equal to the schema owner (do not change it to the runtime role). A role that does
not pass that readiness check, such as the transfer role before the swap or an activation-shell URL
left in place, makes it refuse `rollback-refused-evidence` (the evidence names
`unexpected-state`) with nothing changed.

After a rollback the daemon must run on SQLite again. `rollback` runs the same two-observation
restart check `report` does, against `sqlite`; exit 8 means a running daemon still holds
`postgresql`.

## The maintenance hold, in more detail

When `apply` takes the maintenance hold, it spans the entire capture-and-copy window: capturing the
SQLite source, minting the migration manifest, and copying every batch of records to PostgreSQL.
**The maintenance window scales with the amount of data being migrated** -- a small project's hold
lasts seconds; a large one's can last substantially longer, bounded by how much data has to be read
from SQLite and written to PostgreSQL. There is no separate "how long will this take" answer beyond
the size of what is being copied.

**Daemon presence during the hold.** `apply` positively establishes whether a daemon is running
before taking the hold (never assumed, and never refused merely because none is running -- see
"Daemon presence" below). If a daemon **is** running, ordinary consumer admission -- including that
daemon's own passive-event sweep -- is fenced for the whole hold. A running daemon will log-and-
retry rather than make progress for the duration of the window; this is expected non-progress, not
corruption, and it resolves itself once the hold ends (via `activate` or `abort`). `apply` writes
one line to stderr, before it takes the hold, when a daemon is observed running, and records
`daemonPresent` (and `daemonStorageBackend` when present) in its JSON evidence, as `plan` does.

### Daemon presence

`apply` and `plan` both positively establish daemon presence before proceeding, distinguishing three
genuinely different facts: a daemon is running (recorded, including which storage backend it
reports); no daemon is running, positively confirmed by the absence of both a pid file and any live
process for it; or presence could not be determined at all (refuses `daemon-presence-unresolvable`,
exit 5). A daemon not running is **not** a precondition failure -- nothing in this migration needs a
daemon, and refusing on its absence would force you to start one immediately before a hold that
would then make that daemon's own sweeps fail, which is the exact situation this check exists to
warn about, not require.

### Restarting the daemon after a selection

A durable selection can be correct while a daemon that started earlier still holds the previous
startup backend; it refuses local requests until it restarts. `report` checks this only when a
selection is already durable (an `active` manifest names postgresql; a `rolled-back` manifest or a
settled abort names sqlite; a completed selection in the journal names its own target backend).
`activate` and `rollback` apply the same check to the selection they just made (postgresql and
sqlite). It combines two independent observations, neither decides alone, and exit 0 needs the
first row:

| Restart check | Daemon presence | Exit |
| --- | --- | --- |
| satisfied | none, or running on the selected backend | 0 |
| satisfied | running on a stale backend, or unresolvable | 5 |
| unsatisfied | running on a stale backend | 8 |
| unsatisfied | anything else | 5 |
| unresolvable | any | 5 |

If either observation cannot be made, `report`, `activate` and `rollback` exit 5. The loop is: after an
activation, swap the grants first (see "The cutover: activate and the grant swap"); run
`lcm migration report`; on exit 8 run `lcm daemon restart`; run `report` again until it exits 0.

## What is preserved, and what the probe bound means

**Nothing is ever deleted by this command group.** A failed, aborted, or superseded migration
generation's captured artifacts stay on disk exactly as they were at the point of failure or abort.
`abort` releases the hold and settles the manifest; it does not remove the snapshot, the manifest,
or any evidence associated with the attempt. If you need to reclaim disk space from old attempts,
that is a separate, manual operation outside this command group's scope -- not something `abort`
or any other migration command does for you.

Each project's migration identity is a stable base (derived from the local project and the
PostgreSQL target's non-secret coordinates) plus a small integer **probe ordinal** that increments
each time a fresh cutover attempt is needed -- most visibly, each time an attempt is aborted after
capture and a new one is started. The probe ordinal is bounded; if every ordinal up to that bound is
occupied by a terminal (not cleaned up) generation, `apply`/`plan` refuse
`generation-probe-bound-exceeded` (exit 2), naming cleanup of terminal generations as the remedy.
This is not expected in ordinary use; it would only happen after a large number of aborted attempts
against the same project and target without ever reclaiming their artifacts.

## No drain-liveness claim

A cutover, including a successful `apply`, **does not flush a pending local event backlog**.
Preserving pending events correctly and routing them to the right place on the next read is not the
same as draining them -- nothing in this Epic currently guarantees that a retained backlog is
processed to completion by any specific point in the migration sequence. **The daemon restart that
follows activation is what resumes processing** of anything still pending, not the
migration commands themselves. Do not assume a pending backlog is empty because `apply` succeeded.

## Fencing residue: what this command group does not protect against

The maintenance hold and every refusal in this command group fence **same-host LCM processes only**.
There is no exclusion proof, and none is claimed, across any of the following:

- **A second LCM installation** pointed at the same PostgreSQL database or the same SQLite files
  through a different `~/.lcm` home directory or a different host.
- **A direct `sqlite3` (or any other non-LCM) session** opened against the same SQLite database
  file while a hold is active. LCM's fencing has no way to see or block a connection that does not
  go through its own storage layer.
- **Another host** entirely, for the same reason as the first point.

If you operate more than one LCM installation, or otherwise touch these SQLite files or this
PostgreSQL database outside of this LCM installation's own commands, you are responsible for not
doing so concurrently with a migration hold. This command group cannot detect or prevent that.

## Machine-readable inventory (checked by CI against the CLI's own source of truth)

This block is compared, in both directions, against this candidate's exported exit-class,
command-contract, and refusal-reason constants by a dedicated test
(`test/migration/runbook-conformance.test.ts`). If this block and the source ever disagree, that
test fails -- this section is not prose, and keeping it manually in sync is not the mechanism that
guarantees it stays accurate; the test is. Do not hand-edit this block without re-running that test.

`status: "implemented"` means the command is registered and runnable. All nine commands are
implemented, and a test checks that the commands registered in `bin/lcm.ts` are exactly the ones this
block marks implemented. `canEmit` is the closed set of exit classes the command can produce.

```json
{
  "exitClasses": [
    {
      "code": 0,
      "name": "ok",
      "description": "Completed and its named postcondition was positively read back."
    },
    {
      "code": 1,
      "name": "usage",
      "description": "Malformed invocation. Never reaches a storage seam."
    },
    {
      "code": 2,
      "name": "refused-precondition",
      "description": "State does not admit this operation. Remedy names the command that does."
    },
    {
      "code": 3,
      "name": "refused-confirmation",
      "description": "A mutating boundary was not confirmed."
    },
    {
      "code": 4,
      "name": "refused-contention",
      "description": "Another actor holds the lock, barrier or lease."
    },
    {
      "code": 5,
      "name": "refused-evidence",
      "description": "Evidence is absent, unattributable, or failed its comparison."
    },
    {
      "code": 6,
      "name": "incomplete-recoverable",
      "description": "Durably begun, not terminal, and resume can finish it."
    },
    {
      "code": 7,
      "name": "failed-operator-required",
      "description": "No automatic path resolves this."
    },
    {
      "code": 8,
      "name": "restart-required",
      "description": "Durable state correct; a live daemon holds a stale startup backend, so the cutover is not reportable as successful."
    }
  ],
  "commands": [
    {
      "command": "plan",
      "status": "implemented",
      "exitZeroPostcondition": "Every precondition read succeeded and the emitted evidence is complete, including a positively established daemon presence answer and a computed candidate id.",
      "canEmit": [
        0,
        1,
        2,
        4,
        5
      ]
    },
    {
      "command": "dry-run",
      "status": "implemented",
      "exitZeroPostcondition": "The dry-run completed and its result was read back.",
      "canEmit": [
        0,
        1,
        2,
        4,
        5
      ]
    },
    {
      "command": "apply",
      "status": "implemented",
      "exitZeroPostcondition": "Journal re-read at the expected phase and checksum; snapshot classifies complete; manifest head reads at the expected phase.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7
      ]
    },
    {
      "command": "resume",
      "status": "implemented",
      "exitZeroPostcondition": "The router cell it executed reached its next durable checkpoint, and the manifest was read back at it. With --dry-run, the cell was named and nothing was run or predicted.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8
      ]
    },
    {
      "command": "verify",
      "status": "implemented",
      "exitZeroPostcondition": "The manifest reads verified with nothing pending and its verification report reference names a persisted, activation-eligible report. A verified generation is confirmed from that persisted evidence without writing. With --dry-run, the computation found an eligible report and persisted nothing.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        7
      ]
    },
    {
      "command": "report",
      "status": "implemented",
      "exitZeroPostcondition": "Every reader was read without taking any lock, and no contradiction was found.",
      "canEmit": [
        0,
        1,
        2,
        4,
        5,
        8
      ]
    },
    {
      "command": "activate",
      "status": "implemented",
      "exitZeroPostcondition": "The call returned the confirmed generation's identity, the manifest reads active with nothing pending, and the restart matrix cell is satisfied (verdict satisfied, daemon absent or on the selected backend). --dry-run never exits 0.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8
      ]
    },
    {
      "command": "rollback",
      "status": "implemented",
      "exitZeroPostcondition": "The manifest reads rolled-back with nothing pending for the confirmed generation, read back from disk, and the sqlite restart matrix cell is satisfied. --dry-run never exits 0.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8
      ]
    },
    {
      "command": "abort",
      "status": "implemented",
      "exitZeroPostcondition": "Journal terminal and manifest settled, both read back. Repeating it against a settled pair writes nothing and reads the pair back again.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7
      ]
    }
  ],
  "refusals": [
    {
      "reason": "unexpected-failure",
      "exitClass": "refused-evidence",
      "remedy": "The command hit an unexpected internal failure. Run `lcm doctor`, then `lcm migration plan` to see the current state, and file an issue quoting the evidence."
    },
    {
      "reason": "invalid-expected-owner",
      "exitClass": "refused-precondition",
      "remedy": "storage.postgresql.migrationRole (or LCM_POSTGRES_MIGRATION_ROLE) is not a valid PostgreSQL role name. Fix the configured value before retrying."
    },
    {
      "reason": "machine-identity-unregistered",
      "exitClass": "refused-precondition",
      "remedy": "This machine has no registered PostgreSQL identity. Run `lcm machine register` before retrying."
    },
    {
      "reason": "local-identity-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "This project's persisted identity could not be read. Run `lcm doctor` before retrying."
    },
    {
      "reason": "local-identity-not-persisted",
      "exitClass": "refused-evidence",
      "remedy": "A maintenance hold exists but the current directory has no persisted project identity, and nothing is minted under a hold. Run the command from the migrated project's directory; if it is already there, run `lcm doctor`. `lcm migration abort` releases the hold."
    },
    {
      "reason": "destination-project-absent",
      "exitClass": "refused-evidence",
      "remedy": "A maintenance hold exists but the destination PostgreSQL project does not, and nothing is created under a hold. Run `lcm doctor`; `lcm migration abort` releases the hold."
    },
    {
      "reason": "migration-target-identity-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The destination PostgreSQL project identity could not be resolved or minted. Run `lcm doctor` before retrying."
    },
    {
      "reason": "migration-target-missing",
      "exitClass": "refused-precondition",
      "remedy": "No usable PostgreSQL target is configured. Set storage.postgresql (url, caFile, migrationRole) or the LCM_POSTGRES_URL / LCM_POSTGRES_CA_FILE / LCM_POSTGRES_MIGRATION_ROLE environment variables."
    },
    {
      "reason": "migration-target-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The PostgreSQL target configuration could not be read or parsed. Run `lcm doctor` before retrying."
    },
    {
      "reason": "migration-target-verification-failed",
      "exitClass": "refused-precondition",
      "remedy": "The PostgreSQL target was reached but failed TLS or migration-role verification. Fix the role grants or TLS configuration, then retry."
    },
    {
      "reason": "migration-target-verification-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The PostgreSQL target could not be reached to verify TLS or role access. Check network connectivity and the target address, then retry."
    },
    {
      "reason": "dry-run-failed",
      "exitClass": "refused-evidence",
      "remedy": "The SQLite source could not be dry-run checked. Run `lcm doctor` before retrying."
    },
    {
      "reason": "publication-occupies-slot",
      "exitClass": "refused-contention",
      "remedy": "A v2 publication is in progress. Wait for it to complete, then retry."
    },
    {
      "reason": "journal-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance journal could not be read. Run `lcm doctor` and inspect the backend publication directory under your LCM home before retrying."
    },
    {
      "reason": "generation-occupied-since-probe",
      "exitClass": "refused-contention",
      "remedy": "Another local actor took the candidate generation between the probe and the hold. Retry."
    },
    {
      "reason": "generation-unresolvable-since-probe",
      "exitClass": "refused-evidence",
      "remedy": "The candidate generation could not be re-verified immediately before the hold. Run `lcm doctor` before retrying."
    },
    {
      "reason": "generation-probe-bound-exceeded",
      "exitClass": "refused-precondition",
      "remedy": "Every candidate ordinal up to the probe bound is occupied. Clean up terminal generations, then retry."
    },
    {
      "reason": "generation-occupancy-refused",
      "exitClass": "refused-evidence",
      "remedy": "A candidate generation's occupancy could not be classified. Run `lcm doctor` before retrying."
    },
    {
      "reason": "generation-invalid-input",
      "exitClass": "failed-operator-required",
      "remedy": "The CLI constructed an invalid candidate generation identity. This is an internal defect; file an issue rather than retrying."
    },
    {
      "reason": "generation-identifier-bound-exceeded",
      "exitClass": "failed-operator-required",
      "remedy": "A candidate generation id exceeded the identifier length bound. This is an internal defect; file an issue rather than retrying."
    },
    {
      "reason": "multi-machine-installation",
      "exitClass": "refused-precondition",
      "remedy": "This project is shared across machines. SQLite-to-PostgreSQL migration requires a single-machine (local) project."
    },
    {
      "reason": "hold-entry-contention",
      "exitClass": "refused-contention",
      "remedy": "Another actor holds the publication lock, so the maintenance hold was not entered. Wait, then retry `lcm migration apply`."
    },
    {
      "reason": "hold-entry-slot-occupied",
      "exitClass": "refused-contention",
      "remedy": "A publication or another maintenance hold occupies the journal slot. Wait for it to finish, then re-run `lcm migration plan`."
    },
    {
      "reason": "hold-entry-precondition",
      "exitClass": "refused-precondition",
      "remedy": "The maintenance journal changed while the hold was being entered. Re-run `lcm migration plan` and confirm the id it prints."
    },
    {
      "reason": "hold-entry-evidence",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance journal could not be read or verified while entering the hold. Run `lcm doctor` before retrying."
    },
    {
      "reason": "hold-entry-readback-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance hold could not be confirmed after being entered. Run `lcm doctor` before retrying."
    },
    {
      "reason": "capture-failed",
      "exitClass": "failed-operator-required",
      "remedy": "SQLite snapshot capture failed after the hold was taken. Run `lcm migration abort` to release the hold, then investigate before retrying."
    },
    {
      "reason": "capture-contention",
      "exitClass": "refused-contention",
      "remedy": "Another actor held a lock during capture. The maintenance hold is still in place; re-run `lcm migration apply` with the same --confirm-generation to continue, or run `lcm migration abort` to release it."
    },
    {
      "reason": "capture-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance journal could not be verified during capture. The maintenance hold is still in place; run `lcm doctor`, then re-run `lcm migration apply` to continue or `lcm migration abort` to release it."
    },
    {
      "reason": "continuation-mismatched-hold",
      "exitClass": "refused-precondition",
      "remedy": "An existing maintenance hold does not match this project's current selection. Run `lcm migration abort` before retrying."
    },
    {
      "reason": "continuation-partial-snapshot",
      "exitClass": "refused-precondition",
      "remedy": "The held generation's snapshot is partial or replaced and cannot be resumed. Run `lcm migration abort` to release the hold; the captured evidence is preserved."
    },
    {
      "reason": "continuation-snapshot-tampered",
      "exitClass": "refused-evidence",
      "remedy": "The held generation's snapshot failed its integrity classification. The captured evidence is preserved and no command repairs it. Run `lcm doctor` and inspect the snapshot before deciding; `lcm migration abort` releases the hold without touching the evidence."
    },
    {
      "reason": "continuation-resume-required",
      "exitClass": "refused-precondition",
      "remedy": "A prior cutover reached a state only `resume` can continue. Run `lcm migration resume`."
    },
    {
      "reason": "continuation-unclassified",
      "exitClass": "failed-operator-required",
      "remedy": "The maintenance journal's phase could not be classified into a known continuation. This is an internal defect; file an issue."
    },
    {
      "reason": "abort-gate-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The manifest for a terminal generation could not be read. Run `lcm doctor` before retrying."
    },
    {
      "reason": "abort-or-resume-required",
      "exitClass": "refused-precondition",
      "remedy": "A terminal maintenance journal has an unsettled manifest. Run `lcm migration abort` or `lcm migration resume` before starting a fresh cutover."
    },
    {
      "reason": "entering-recovery-precondition",
      "exitClass": "refused-precondition",
      "remedy": "The recovered entering journal does not match this project's current selection. Run `lcm migration abort` before retrying."
    },
    {
      "reason": "entering-recovery-contention",
      "exitClass": "refused-contention",
      "remedy": "Another actor holds the publication lock during recovery. Wait and retry."
    },
    {
      "reason": "entering-recovery-evidence",
      "exitClass": "refused-evidence",
      "remedy": "The entering journal's recovery could not be verified. Run `lcm doctor` before retrying."
    },
    {
      "reason": "entering-recovery-unclassified",
      "exitClass": "failed-operator-required",
      "remedy": "The entering journal's recovery failure could not be classified. This is an internal defect; file an issue."
    },
    {
      "reason": "snapshot-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The captured SQLite snapshot could not be classified. Run `lcm doctor` before retrying."
    },
    {
      "reason": "capture-incomplete",
      "exitClass": "refused-precondition",
      "remedy": "Capture-before-genesis ordering requires a complete snapshot before manifest genesis. Retry `lcm migration apply`."
    },
    {
      "reason": "manifest-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The migration manifest could not be read. Run `lcm doctor` before retrying."
    },
    {
      "reason": "genesis-inspection-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Inspecting the source and destination witnesses for manifest genesis failed. Investigate the target PostgreSQL connection before retrying."
    },
    {
      "reason": "genesis-create-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Manifest genesis failed after a successful capture. Run `lcm doctor`; the snapshot is preserved and safe to retry from."
    },
    {
      "reason": "genesis-dry-run-begin-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Beginning the dry-run copy effect failed. Run `lcm doctor` before retrying."
    },
    {
      "reason": "genesis-dry-run-complete-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Completing the dry-run copy effect failed. Run `lcm doctor` before retrying."
    },
    {
      "reason": "genesis-dry-run-effect-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "The pending dry-run effect is not the one resume carried. Nothing was changed; run `lcm migration report` and inspect the evidence."
    },
    {
      "reason": "genesis-dry-run-unexpected-state",
      "exitClass": "refused-precondition",
      "remedy": "The manifest is no longer waiting for its dry-run effect. Nothing was changed; run `lcm migration report` to see which command owns it now."
    },
    {
      "reason": "resume-readback-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "The resumed step appeared to complete but the manifest does not read back at the expected checkpoint. Run `lcm migration report` and inspect the evidence."
    },
    {
      "reason": "copy-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Copying captured data to the destination failed. The source snapshot is preserved; run `lcm doctor` before retrying."
    },
    {
      "reason": "confirmation-missing",
      "exitClass": "refused-confirmation",
      "remedy": "Run `lcm migration plan` first, then pass its printed generation id to `apply --confirm-generation <id>`."
    },
    {
      "reason": "confirmation-generation-moved",
      "exitClass": "refused-confirmation",
      "remedy": "The candidate generation changed since `lcm migration plan` was run. Re-run `lcm migration plan` and confirm the new id."
    },
    {
      "reason": "daemon-presence-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "Daemon presence could not be positively established. Run `lcm daemon status`, resolve the failure, and retry."
    },
    {
      "reason": "abort-wrong-phase",
      "exitClass": "refused-precondition",
      "remedy": "The maintenance journal is not in an abortable phase (it is either absent or already past a successful cutover). Nothing to abort."
    },
    {
      "reason": "abort-journal-moved",
      "exitClass": "refused-precondition",
      "remedy": "The maintenance journal changed since it was last observed. Re-run `lcm migration abort` to act on its current state."
    },
    {
      "reason": "abort-invalid-input",
      "exitClass": "failed-operator-required",
      "remedy": "The CLI constructed an invalid abort request. This is an internal defect; file an issue rather than retrying."
    },
    {
      "reason": "abort-manifest-needs-resume",
      "exitClass": "incomplete-recoverable",
      "remedy": "A copy or verification effect began on this generation's manifest after the router chose abort. Nothing was changed. Run `lcm migration resume` to finish it, then abort if you still want to."
    },
    {
      "reason": "abort-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The abort could not be classified into a known precondition or defect. Run `lcm doctor` before retrying."
    },
    {
      "reason": "abort-confirmation-missing",
      "exitClass": "refused-confirmation",
      "remedy": "Pass --confirm-generation with the generation id of the live maintenance hold. This refusal reports that id in its generation field; nothing was changed."
    },
    {
      "reason": "abort-confirmation-moved",
      "exitClass": "refused-confirmation",
      "remedy": "--confirm-generation does not match the live maintenance hold. Pass the generation id this refusal reports; nothing was changed."
    },
    {
      "reason": "abort-nothing-to-abort",
      "exitClass": "refused-precondition",
      "remedy": "There is no maintenance hold to abort."
    },
    {
      "reason": "generation-required",
      "exitClass": "refused-precondition",
      "remedy": "No live maintenance hold identifies the generation. Pass --generation <id>; `lcm migration report` lists what is known."
    },
    {
      "reason": "generation-unknown",
      "exitClass": "refused-precondition",
      "remedy": "No journal or manifest exists for that generation id. Check the id passed to --generation."
    },
    {
      "reason": "generation-invalid",
      "exitClass": "usage",
      "remedy": "The value passed to --generation is not a valid generation id. Nothing was read or changed."
    },
    {
      "reason": "route-not-owner",
      "exitClass": "refused-precondition",
      "remedy": "This generation's state is owned by a different command. Run the command this refusal names as next; nothing was changed."
    },
    {
      "reason": "route-publication-in-flight",
      "exitClass": "refused-contention",
      "remedy": "A v2 publication occupies the journal slot for this generation. Wait for it to settle, then run `lcm migration report`."
    },
    {
      "reason": "route-resume-required",
      "exitClass": "incomplete-recoverable",
      "remedy": "This generation has durably begun work that only `lcm migration resume` (or `verify` where this refusal names it) can finish. Nothing was changed."
    },
    {
      "reason": "route-operator-required",
      "exitClass": "failed-operator-required",
      "remedy": "No automatic command settles this generation's state. Nothing was changed; run `lcm migration report` and inspect the evidence."
    },
    {
      "reason": "route-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance journal could not be read, so no command can be chosen. Run `lcm doctor` before retrying."
    },
    {
      "reason": "route-foreign-publication",
      "exitClass": "refused-evidence",
      "remedy": "The journal slot holds a publication that does not belong to this generation. Nothing was changed; run `lcm migration report`."
    },
    {
      "reason": "route-contradiction",
      "exitClass": "refused-evidence",
      "remedy": "The journal, manifest and snapshot of this generation contradict each other. Nothing was changed; run `lcm doctor` and inspect the evidence."
    },
    {
      "reason": "existing-confirmation-missing",
      "exitClass": "refused-confirmation",
      "remedy": "Pass --confirm-generation with the generation id this refusal reports; nothing was changed."
    },
    {
      "reason": "existing-confirmation-moved",
      "exitClass": "refused-confirmation",
      "remedy": "--confirm-generation does not match the resolved generation. Pass the id this refusal reports; nothing was changed."
    },
    {
      "reason": "verify-contention",
      "exitClass": "refused-contention",
      "remedy": "Another worker holds the verification lease or the source append barrier, or the lease was lost. No effect was begun; run `lcm migration verify` again."
    },
    {
      "reason": "verify-not-eligible",
      "exitClass": "refused-evidence",
      "remedy": "The verification found mismatches or incomplete coverage. A non-eligible report is kept as evidence, and the generation stays copied. Run `lcm migration report` and inspect it."
    },
    {
      "reason": "verify-project-map-drift",
      "exitClass": "refused-evidence",
      "remedy": "The project map no longer matches the generation's destination project. Nothing was changed; run `lcm doctor` and inspect the project map."
    },
    {
      "reason": "verify-project-map-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The project map could not be read for the verification witness. Run `lcm doctor` before retrying."
    },
    {
      "reason": "verify-report-identity-conflict",
      "exitClass": "refused-evidence",
      "remedy": "The pending verification effect does not name an activation-eligible persisted report. Nothing was changed; run `lcm doctor` and inspect the evidence."
    },
    {
      "reason": "verify-destination-drift",
      "exitClass": "refused-evidence",
      "remedy": "The persisted verification report does not match the destination the copy sealed in the manifest. Nothing was changed; the evidence is preserved."
    },
    {
      "reason": "verify-invalid-input",
      "exitClass": "failed-operator-required",
      "remedy": "The CLI constructed an invalid verification request. This is an internal defect; file an issue rather than retrying."
    },
    {
      "reason": "verify-report-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The persisted verification report could not be read. Run `lcm doctor` before retrying."
    },
    {
      "reason": "verify-readback-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "The verification appeared to complete but the manifest and its report do not read back as verified. Run `lcm migration report` and inspect the evidence."
    },
    {
      "reason": "report-restart-required",
      "exitClass": "restart-required",
      "remedy": "The durable selection is correct, but a running daemon still holds the previous startup backend. Restart the daemon (`lcm daemon restart`), then run `lcm migration report` again."
    },
    {
      "reason": "report-restart-contradiction",
      "exitClass": "refused-evidence",
      "remedy": "The daemon restart check and the daemon presence observation disagree, so neither can be trusted alone. Run `lcm daemon status`, resolve the difference, and report again."
    },
    {
      "reason": "report-restart-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The daemon restart check could not be made. Run `lcm daemon status`, resolve the failure, and report again."
    },
    {
      "reason": "report-selection-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The journal records a completed selection without naming its backend. Nothing was changed; run `lcm doctor` and inspect the evidence."
    },
    {
      "reason": "report-evidence-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "A reader of the activation or rollback evidence could not give an answer, or a report the manifest references (including the verification report) is missing or unreadable. The report still prints every section it read; run `lcm doctor` and inspect the evidence named as unresolvable or missing."
    },
    {
      "reason": "abort-carried-effect-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "The pending abort effect on the manifest is not the one an abort of this generation begins. Nothing was changed; run `lcm doctor` and inspect the evidence."
    },
    {
      "reason": "abort-other-generation",
      "exitClass": "refused-precondition",
      "remedy": "The terminal maintenance journal belongs to a different generation than the one named. Nothing was changed; omit --generation to act on the journal's own generation."
    },
    {
      "reason": "abort-readback-mismatch",
      "exitClass": "failed-operator-required",
      "remedy": "The abort appeared to complete but its terminal state could not be confirmed on readback. Run `lcm doctor` and inspect the maintenance journal and manifest directly."
    },
    {
      "reason": "backend-confirmation-missing",
      "exitClass": "refused-confirmation",
      "remedy": "Pass --confirm-backend with the backend this command switches to: postgresql for activate, sqlite for rollback. Nothing was changed."
    },
    {
      "reason": "backend-confirmation-moved",
      "exitClass": "refused-confirmation",
      "remedy": "--confirm-backend does not match the backend this command switches to (postgresql for activate, sqlite for rollback). Nothing was changed."
    },
    {
      "reason": "activation-refused-precondition",
      "exitClass": "refused-precondition",
      "remedy": "Activation was refused before it began any effect: the evidence names the step and the reason. Fix that condition, then run `lcm migration activate` again. `lcm migration report` shows the current state."
    },
    {
      "reason": "activation-refused-contention",
      "exitClass": "refused-contention",
      "remedy": "Another actor holds the activation lease. Nothing was changed; wait for it to finish or expire, then run `lcm migration activate` again."
    },
    {
      "reason": "activation-refused-evidence",
      "exitClass": "refused-evidence",
      "remedy": "Activation could not establish a fact it needs and refused before it began any effect: the evidence names the step and the reason. Run `lcm doctor` and `lcm migration report` before retrying."
    },
    {
      "reason": "activation-refused-resume",
      "exitClass": "incomplete-recoverable",
      "remedy": "A pending effect on this generation is finished by `lcm migration resume`. Nothing was changed; run it with the same --confirm-generation."
    },
    {
      "reason": "activation-not-begun",
      "exitClass": "refused-precondition",
      "remedy": "Activation was interrupted before its first durable effect, so the manifest is unchanged. A lease it took may be held until it expires (15 minutes) or a later run takes it over; run `lcm migration activate` again."
    },
    {
      "reason": "activation-interrupted",
      "exitClass": "incomplete-recoverable",
      "remedy": "Activation was interrupted after beginning durable work. Run `lcm migration activate` again with the same confirmations; the re-entry finishes it. The evidence names the step, the cause and what is known to have been applied."
    },
    {
      "reason": "activation-publication-failed",
      "exitClass": "refused-evidence",
      "remedy": "The backend publication did not complete: the evidence names its status. Run `lcm migration report` and inspect the evidence before deciding between `activate` again and `rollback`."
    },
    {
      "reason": "activation-post-publication-unhealthy",
      "exitClass": "refused-evidence",
      "remedy": "The publication completed but the PostgreSQL target did not pass its health check, so the cutover is not complete. Fix the target (the evidence names the reason), then run `lcm migration activate` again."
    },
    {
      "reason": "activation-identity-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "Activation answered for a generation other than the one confirmed, so its result is not accepted. Run `lcm migration report` for each generation and inspect the evidence."
    },
    {
      "reason": "activation-readback-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "Activation reported success but the manifest does not read back as active with nothing pending. Run `lcm migration report` and inspect the evidence."
    },
    {
      "reason": "activation-invalid-input",
      "exitClass": "refused-evidence",
      "remedy": "The activation request was rejected as invalid before anything ran. This is an internal defect; file an issue with the evidence."
    },
    {
      "reason": "activation-unexpected-state",
      "exitClass": "refused-evidence",
      "remedy": "Activation found state it does not recognise and stopped. Run `lcm migration report` and inspect the evidence before retrying."
    },
    {
      "reason": "activation-dry-run-not-predictive",
      "exitClass": "refused-evidence",
      "remedy": "The activation preview reads the persisted state but does not evaluate quiescence, coverage, the project-coverage refusal, the lease, target health or the census, so it cannot say activation would succeed. The evidence lists what it read and what it did not."
    },
    {
      "reason": "cutover-restart-required",
      "exitClass": "restart-required",
      "remedy": "The durable selection is correct, but a running daemon still holds the previous startup backend. Swap the grants first (add the runtime grants, revoke the transfer grants), restart the daemon, then run `lcm migration report`."
    },
    {
      "reason": "cutover-restart-contradiction",
      "exitClass": "refused-evidence",
      "remedy": "The daemon restart check and the daemon presence observation disagree, so neither can be trusted alone. Run `lcm daemon status`, resolve the difference, and run `lcm migration report`."
    },
    {
      "reason": "cutover-restart-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The daemon restart check could not be made. Run `lcm daemon status`, resolve the failure, and run `lcm migration report`."
    },
    {
      "reason": "rollback-refused-precondition",
      "exitClass": "refused-precondition",
      "remedy": "Rollback refused because the generation is not eligible or the installation is not quiescent: the evidence names which. Rollback also refuses while any other project is remotely bound, because the backend selection is global. Fix the named condition, then run `lcm migration rollback` again."
    },
    {
      "reason": "rollback-contention",
      "exitClass": "refused-contention",
      "remedy": "The rollback lease was lost or is held by another actor. Re-running `lcm migration rollback` with the same confirmations re-enters whatever was begun."
    },
    {
      "reason": "rollback-refused-evidence",
      "exitClass": "refused-evidence",
      "remedy": "Rollback could not establish a fact it needs, or found state that contradicts the generation: the evidence names which. Run `lcm doctor` and `lcm migration report` and inspect the evidence before retrying. If the evidence names unexpected-state, check that LCM_POSTGRES_URL is the runtime role's connection (not the transfer role's) and that migrationRole is still the schema owner."
    },
    {
      "reason": "rollback-abandoned",
      "exitClass": "refused-precondition",
      "remedy": "An interrupted publication could not be proven complete, so rollback abandoned it and the generation returned to its previous phase with an abandonment report. Nothing was rolled back; run `lcm migration rollback` again."
    },
    {
      "reason": "rollback-readback-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "Rollback reported a result that the manifest does not read back as rolled-back with nothing pending. Run `lcm migration report` and inspect the evidence."
    },
    {
      "reason": "rollback-dry-run-not-predictive",
      "exitClass": "refused-evidence",
      "remedy": "The rollback preview reads only the route and the manifest. It does not evaluate eligibility, mode, quiescence, the lease, drift, remote bindings or the restart check, so it cannot say rollback would succeed."
    }
  ]
}
```

## See also

- `docs/migration-cutover.md` -- the internal design of the checksum-sealed migration journal and
  capture protocol this command group drives. Read this document (the operator runbook) first;
  that one is for understanding the mechanism, not for running commands.
- `docs/backend-publication.md` -- the backend publication and maintenance-journal protocol
  `apply`'s hold is built on, including why a live daemon's frozen startup backend is a separate
  gate from durable state correctness.
- `docs/cli.md` -- the general command-line behavior this group follows.
- `lcm migration --help` -- the group help page, which lists every command and flag. It is one page
  for the whole group: `lcm migration apply --help` shows the same page, and the per-command flag
  descriptions are in "Commands" above.
