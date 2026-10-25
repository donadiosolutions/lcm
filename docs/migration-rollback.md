# Reversible migration rollback

LCM can reverse a PostgreSQL migration attempt back to SQLite. This page
describes what rollback does, what it deliberately leaves untouched, how to
read a refusal, and how to recover after an interruption. It assumes you have
already read [Reversible migration and cutover journal](migration-cutover.md),
which covers the shared journal, phases, and crash-recovery discipline
rollback builds on.

## The two shapes of a rollback, and the one that copies nothing

Rollback has two outcomes, decided from evidence at the moment it runs, never
chosen by the operator:

- **Pre-write rollback copies nothing.** If PostgreSQL was activated (the
  activation recorded its evidence and published the PostgreSQL selection) but
  nothing was durably written to it since, the live SQLite database at the
  canonical path is already correct and current.
  No rollback generation is built, nothing is installed, no
  runtime sidecar is materialized, and the live database is not touched. The
  reversal is the maintenance-selection flip back to SQLite, nothing else.
  Reconstructing the database from the preserved snapshot in this case would
  not be a missing feature; it would replace a correct live file with a
  reconstruction and is treated as a defect if it ever happens.
- **Post-write rollback rebuilds a fresh generation.** If PostgreSQL received
  writes after activation, rollback builds a new SQLite generation from a
  fenced PostgreSQL snapshot, verifies it twice against independent
  readbacks, installs it at the canonical path, and only then flips the
  selection back to SQLite.

Either way, rollback never deletes or truncates anything it did not itself
create in the same run.

## What is preserved, and never overwritten

- The immutable snapshot captured before the original migration (tracked
  since issue #622) stays untouched at private mode 0400 in its own
  generation directory. Rollback never reads its bytes; on a post-write
  rollback the new generation is built fresh from PostgreSQL, not from this
  snapshot.
- On a post-write rollback, the live pre-rollback SQLite database is moved
  aside to a lineage path, never truncated, replaced in place, or unlinked.
  It is checkpointed and witnessed by content hash both before and after the
  move, so the preserved copy is provably byte-identical to what was live.
- Rollback does not delete the destination project or its alias rows in
  PostgreSQL: the canonical path and every project-map alias that `apply`
  migrated stay there, and the local project map keeps listing the same
  aliases.

## A generation that never activated cannot be rolled back

Rollback unwinds an activation, and it finds the project's PostgreSQL id in
the project map entry that the activation's publication writes. A generation
that never activated has no such entry (the project map does not yet bind the
project), and no durable local record holds the id before then. Rollback
refuses with `project-unbound`, and the same applies when the configuration
does not select PostgreSQL.

The same holds when the configuration and the project map were switched to
PostgreSQL by hand, without an activation: there is no activation evidence
and no completed publication, so there is nothing to unwind, and flipping the
maintenance selection alone would leave every consumer refusing the mismatch
between the configuration and the selection. Rollback refuses with
`not-eligible` ("never completed an activation") before it enters maintenance,
takes a lease or touches the manifest. Nothing was changed; restore the
configuration and the project map to SQLite, or leave the generation with:

```bash
lcm migration abort
```

The protocol permits an abort from planned through verified. The refusal
message names this command.

## Only one project may be remotely bound

The maintenance selection flip moves the whole installation's backend
selection back to SQLite. If another project is also bound to PostgreSQL in
the project map, it would be silently stranded on a backend it no longer
routes to. Rollback therefore refuses (`multiple-remote-projects`) unless the covered project is the only one bound to
PostgreSQL. A local-only entry never blocks. The check runs before maintenance
is entered and again right before the selection is prepared. Unbind or migrate
the other projects first. This is the single-generation rollback's rule.
A home whose projects moved together as a cutover set is rolled back with the
set form, which returns every member to SQLite through one publication, so
the global selection is never split:

```bash
lcm migration rollback --set --generation <original-set-id> \
  --confirm-generation <original-set-id> --confirm-backend sqlite
```

Always pass the **original** activated set id, also to resume an interrupted
set rollback; the rollback hold has its own derived id, which the report
prints as `rollbackSetId` and no command accepts. Every member gets a new SQLite
generation and the original member generations are kept as history. The set
rollback uses the runtime-role `LCM_POSTGRES_URL` as above, needs PostgreSQL
reachable (there is no offline restoration), and has no abort once its
checkpoint is written. Do not unbind projects by hand to get past the
single-generation refusal: it protects the members of a set from a split
selection. See
[Cutover sets: rolling a set back](migration-cutover-set.md#rolling-a-set-back)
and [the operator runbook](migration-cutover-set.md#running-a-set-with-lcm-migration---set).

## What activation evidence rollback relies on

For an activation that recorded its evidence, rollback compares the
PostgreSQL destination against the activation's epoch (the destination
identity and the baseline census) to decide pre-write or post-write, and it
records its own witness before it changes anything. It reads the activation's
retained backend publication before it prepares its own, and persists the
publication identity, the source backend, the project map entry and the
digests of the source configuration and map. A rollback artifact written by an
older version refuses distinctly. When the retained publication is absent or
unreadable, rollback refuses.

## Recovery procedure after an interrupted rollback

A rollback can be interrupted at any point -- before entering maintenance,
while maintenance is held, mid-build, or after the destination selection has
already flipped but before the run finished recording that fact. Every one of
those windows resumes to exactly one authoritative outcome, and a retry
resolves every one of them except the cases described under "A prepared
selection that drifted" and "An externally aborted rollback publication" below
when the destination changed in between.

On a post-write rollback specifically, a retry after a crash **never
resumes copying into the same partial generation**. It builds a brand-new
generation directory, one attempt number higher than any attempt already on
disk for that generation and destination revision. The incomplete or failed
generation from the earlier attempt is left exactly where it is: private,
un-deleted, and, if the earlier attempt got far enough to know it failed
verification, quarantined read-only. This is deliberate. A failed or
incomplete generation is evidence of what the earlier attempt actually wrote,
and quarantining it is safer than any hidden repair.

The same holds after the selection flips. A crash after the maintenance
selection, while or after the coordinator prepared the rollback's own
publication (including before it finished sealing that publication's material),
after the configuration was published, or after the publication completed
resumes from where it stopped when the same operation is run again: the
rollback records its selection binding as soon as the selection completes,
resumes or verifies the coordinator publication from the material it sealed,
and then writes its report and settles the generation as `rolled-back`. A
`rolled-back` generation whose binding was lost to a crash gets it written
on the next run.

Simply re-running the same rollback operation triggers this recovery
automatically; there is nothing an operator needs to do to make a stalled
rollback resumable, other than removing whatever caused the crash (an
unreachable PostgreSQL host, a permissions problem, and so on) and running it
again.

### A prepared selection that drifted

One window does not resolve by retry. If the run died after the maintenance
selection was *prepared* but before it was *completed*, and PostgreSQL was then
written to by something that bypassed the publication guard (the rollback's
lease is still held, so an ordinary guarded writer is refused), the retry
re-reads the destination under a fresh fence and finds that it no longer
reproduces the evidence the prepared selection was authorized on. Completing
that selection would publish a stale decision, so the retry refuses with
`drift` ("the destination no longer reproduces the pending publish-rollback's
terminal evidence; the prepared selection is not completed") and changes
nothing: the maintenance journal stays at `selection-prepared`, the effect
stays pending, the lease stays held, PostgreSQL stays authoritative and the
out-of-band data is preserved. Every further retry refuses the same way,
because the coordinator has no abort from `selection-prepared` (tracked as
#1529).

What the operator sees is that same `drift` refusal on every run. Do not
force a re-selection or edit the journal: investigate the write that got past
the fence, and treat the installation as PostgreSQL-authoritative until #1529
provides the authenticated abort that returns it to a resumable state.

### An externally aborted rollback publication

The rollback's own backend publication can be aborted by something other than
the rollback (an operator or another tool running the publication abort). An
abort restores the configuration and project map the publication began from,
releases the PostgreSQL lease it had recorded and removes the publication's
sealed material; it can also stop part-way, for instance after the lease was
released but before the publication was marked aborted. The rollback itself
stays pending in every case, and running the same rollback operation again
completes it:

1. When the abort stopped part-way after it had already removed the sealed
   material, the live configuration and project map are checked first: they
   must be byte-for-byte the files the publication recorded as its source. A
   file edited since then refuses the run (`unexpected-state` or
   `not-eligible`) before the abort is finished and before any session is
   opened, so the journal stays at `abort-releasing`.
2. A part-way abort is then finished, without opening any PostgreSQL session,
   and the restored files are checked against the same witness again. A
   mismatch refuses the run (`unexpected-state` or `not-eligible`) and
   changes nothing further: the aborted journal, the pending effect and the
   lease row are left as they were. A lease the abort released stays released,
   and a lease the publication never acquired is left unchanged.
3. A session then takes the rollback's lease: a new lease token when the abort
   released the one the publication held, or the existing lease when the
   publication never acquired one.
4. The destination is re-read under that lease and must still reproduce the
   pending rollback's terminal evidence, and the activation authority is
   resolved again. Because the rollback's own aborted publication now occupies
   the slot where the activation's operability fact used to be read, that fact
   is taken from the rollback authority artifact written before the rollback
   began, only after the live slot reports no positive fact; an unreadable slot
   or a missing artifact refuses.
5. Only then is the publication prepared again over the aborted journal, which
   is archived, and published forward as usual. The rollback settles as
   `rolled-back`, replay admission routes to SQLite from the rollback
   binding, and the lease is released.

If step 4 finds that the destination drifted (or the authority no longer
resolves), the run refuses with `drift` or `not-eligible` and changes
nothing further. What remains is the pending `publish-rollback` effect, the
aborted publication in the slot, the lease held by the recovery session, the
PostgreSQL configuration and project map the abort restored, and replay
admission routed to SQLite from the rollback binding. Every further retry
refuses the same way until the destination again reproduces the recorded
evidence. Do not edit the journal or the restored files. The composition check
on the journal (PostgreSQL back to the pre-activation backend, for the covered
project) proves what the publication was meant to do; it does not prove that
the restored files are the original bytes, which is why the files are compared
with the recorded witnesses.

## Operator-owned cleanup of quarantined and incomplete generations

Rollback generations, including quarantined and abandoned ones, live under
`<home>/.lcm/migration-rollback-generations/`. **LCM never deletes anything
in this directory.** Every attempt, successful or not, accumulates there
indefinitely. This is intentional: a failed attempt is the only record of
what went wrong, and an operator investigating a rollback failure needs that
evidence to still exist.

A post-write rollback also preserves the database it replaced, read-only, as
`preempted-canonical.sqlite` inside the directory of the generation that
replaced it, and records that move in
`<home>/.lcm/migration-rollback-preemptions/<generation id>.json` before it
happens. The record lists every move of that rollback in order and never
rewrites a completed one: the first completed move is the original, the
pre-rollback database itself, and that is the file the rollback reports as
preserved. A retry after a crash between the install and the selection moves
the generation it had installed aside as a later move, recorded beside the
original, which stays where it was. A retry after a crash in the middle of a
move finishes it from the record (the preserved file is checked to be a plain
file, made read-only, flushed and verified against the bytes recorded before
the move). Before acting on a record, the rollback checks that it names the
same canonical database and that every file it recorded as preserved is still
exactly that file: a plain, single-link, read-only file with the recorded
identity and bytes. A preserved file that is missing, replaced, rewritten,
writable or linked elsewhere, a record for another canonical path, or a live
database beside an unfinished move all refuse rather than guess. Treat the
record like the generation directories: it is evidence, and LCM never deletes it.

Because nothing is deleted automatically, disk usage under this directory
grows with every rollback attempt on every generation, successful or not.
Reviewing and removing directories you no longer need is an operator
decision, made after you have confirmed you do not need the evidence they
contain. LCM does not provide a command for this today; treat each directory
like any other evidence file you manage by hand.

## Refusals, and what to do about each one

Rollback refuses rather than guessing whenever it cannot prove what it needs
to prove. Every refusal is fail-closed: nothing has been overwritten by the
time you see it. The table below groups refusals by what they mean and what
to check.

| What you will see | What it means | What to check |
| --- | --- | --- |
| Operability fact unresolvable (lock contention, an unreadable or malformed publication journal) | Rollback could not authoritatively determine whether PostgreSQL is currently the active backend, so it will not guess. | Confirm nothing else is holding the backend-publication lock; inspect the publication journal for corruption; retry once the underlying condition clears. |
| "backend maintenance holds the live publication slot and no durable rollback-authority artifact exists" | Something else (not this rollback attempt) currently holds backend maintenance, and there is no evidence tying that hold to this rollback. | This is not this rollback's own in-progress maintenance. Identify what else is holding maintenance before retrying. |
| "the live operability fact disagrees with the durable rollback-authority artifact" | A value recorded durably before maintenance began no longer matches what a fresh read reports, for the exact same generation. Rollback treats this as untrustworthy evidence rather than picking a side. | Investigate why the backend's operability state changed between the recorded value and now -- this should not happen for one generation's own rollback and points at something external. |
| "operability-fact:published-but-unbound: destination is operable under postgresql but no activation selection binding is bound yet" | PostgreSQL is live and operable, but the record of which activation attempt made it so has not been durably written yet. Treating this as "never activated" would license discarding real committed writes, so rollback refuses instead. | Wait for the in-flight activation to finish durably recording its selection binding, then retry. |
| "destination identity does not match the manifest's sealed witness" / "...does not match the authoritative epoch" | The PostgreSQL system rollback is looking at is not the same PostgreSQL system the manifest or the activation attempt recorded. | Confirm you are pointed at the correct PostgreSQL target; do not proceed by forcing a match. |
| "observed census schema is not comparable to the frozen portable record schema" | The row-count census read from PostgreSQL was produced under a different portable-record schema version than rollback expects, so a pre-write/post-write comparison would not be meaningful. | Confirm the LCM version that ran the original migration matches the version running rollback. |
| A refusal reason surfaced from the classifier comparing the current PostgreSQL delta and census against the activation baseline | Rollback could not determine, from the evidence available, whether PostgreSQL has been written to since activation. | Treat this the same as any other refusal to guess: it means the census or delta comparison itself was inconclusive, not that no write occurred. |
| "rollback generation ... already exists" | The exact generation directory rollback was about to create is already occupied. This should not happen given the attempt-numbering scheme above; it points at an unexpected collision. | Do not delete the existing directory to "fix" this. Report it; this indicates the attempt-numbering derivation and the filesystem disagree. |
| "could not enumerate existing rollback generation build attempts" / "...has more entries than this enumeration will scan" | Rollback could not safely determine the next attempt number for this generation, either because the private generations directory could not be read or because it holds an implausibly large number of entries. Rollback refuses rather than risk reusing an attempt number that is already evidence. | Check filesystem permissions on `.lcm/migration-rollback-generations/`; if the entry count is genuinely large, that is itself worth investigating -- it means many prior attempts were never cleaned up. |
| Independent verification failure recorded in a generation's `witness.json` `reason` field (`transfer:*`, `independent-verification:manifest-readback-failed`, `independent-verification:manifest-sha-mismatch`, `independent-verification:readback-failed`, `independent-verification:content-mismatch`) | The newly built generation failed one of the two independent verification passes rollback runs before it will ever install a generation. The generation was quarantined, not installed. | Read the `witness.json` file in that generation's directory for the exact reason. The quarantined generation and its manifest are preserved; do not repair a partial generation by editing its files. Rollback will build a fresh attempt on retry. |
| "publish-rollback must be abandoned but the maintenance journal is already durably selection-completed for a different or ambiguous target" | A crash-recovery path found backend selection already durably completed toward a target rollback cannot reconcile automatically. This is a known, explicitly unimplemented case, flagged loudly rather than silently guessed at. | This needs manual investigation; do not attempt to force a re-selection. |
| "backend publication is unresolved; recover it before consuming local state" | An activation's publication is still in flight (a crash while it published). Rollback does not start over it. | Finish or abort the activation first. A rollback's own interrupted publication is not this refusal: re-running resumes it. |
| `published-but-unbound` | PostgreSQL is live (its publication completed) but the activation never recorded its selection binding. | Let the activation record it, then retry. |
| `project-unbound`, or "the configuration selects another" | The generation never activated. | Run `lcm migration abort`. |
| "never completed an activation" (`not-eligible`) | No activation selection was ever bound, although the configuration selects PostgreSQL (for example, it was switched by hand). There is nothing to roll back from, and nothing was changed. | Restore the configuration and the project map to SQLite, or run `lcm migration abort`. |
| `multiple-remote-projects`, `covered-project-mismatch` | The project map binds another project to PostgreSQL. | See "Only one project may be remotely bound". |
| "actively held by a different publication generation" | The activation's fence on the PostgreSQL project is still held, so a rollback cannot take it over. | Wait for the holder to finish or its lease to expire; rollback does not break a live lease. |
| Drift: the destination changed between the export and the final check, or the rollback mode changed | PostgreSQL was written to while rollback was building, so the generation it built no longer matches. | Nothing was installed or selected. Run the rollback again. |
| Drift on a retry: "the destination no longer reproduces the pending publish-rollback's terminal evidence; the prepared selection is not completed" | A prepared selection's destination was written to out of band before the retry (see "A prepared selection that drifted"). | The selection stays prepared and nothing is changed; a retry refuses again until #1529 lands. Manual investigation; do not force a re-selection. |

A production rollback ends with one of seven reasons: `not-eligible`,
`unresolvable`, `lease-lost`, `quiescence-unsatisfied`, `drift`,
`input-unresolvable` or `unexpected-state`. The first five map the refusals
above; `input-unresolvable` means the inputs it derives from durable state
(the manifest, the preserved snapshot, the configuration, the project map or
this machine's identity) cannot be resolved, including the never-activated
case; `unexpected-state` carries any failure that does not fit, with the
original message.

Every refusal preserves whatever durable evidence already existed. None of
them require, or benefit from, deleting files to "retry cleanly."

A refusal after rollback has entered its maintenance window (the readback's
eligibility check, or an abandoned recovery of a pending selection) closes
that window as aborted, and an aborted rollback window leaves PostgreSQL
selected: the maintenance journal records the backend the window was entered
from, so consumers keep opening PostgreSQL. Replay admission keeps resolving
PostgreSQL as well: for a generation with its activation binding, the binding
answers PostgreSQL for the activation evidence and refuses the abort evidence
(bindings decide before the maintenance journal); only when no binding decides
is the abort evidence itself admitted, on PostgreSQL. Neither path ever answers
SQLite. Only an aborted activation window selects SQLite, because that is the
backend it was entered from.

## Upgrading LCM during a rollback

The portable schema digest changes in the release that adds
`conversations.parent_session_id`. Census evidence and cutover proof
manifests produced by an older LCM fail closed with `incompatible-schema`
under the new binary. Finish or abandon an in-flight rollback before
upgrading, then rerun it with the new binary.

## The maintenance window scales with data size

Rollback holds the same PostgreSQL fence used by the forward migration for
the full duration of its destination scan -- reading the current census and
delta, and, on a post-write rollback, transferring every domain into the new
SQLite generation. The fence is renewed across long scans rather than held in
a single non-renewable lease, but it is held throughout: while the census scan
or the export is in flight the lease is renewed every five minutes (a third of
its fifteen-minute lifetime), and a renewal that fails stops the scan rather
than letting it finish unfenced. That renewal needs a PostgreSQL connection of
its own beside the one the scan holds, so it runs only when `poolMax` is at
least 2; with a single-connection pool each scan has to finish within the
fifteen-minute lease. Size any expected
outage window from the amount of data PostgreSQL holds, not from a fixed
estimate: a larger destination means a longer window during which PostgreSQL
writes from this project are fenced.

## Backlog drain after rollback

Appends made locally while maintenance is held are preserved and admitted
through the same local outbox mechanism used during the original cutover.
Rollback does not flush the backlog that accumulated after the forward
cutoff: once the selection is back on SQLite, the daemon's passive sweep
drains it (see [Passive learning](passive-learning.md)). Until that sweep
has run, the backlog stays preserved and correctly routed.

An archived passive event can already be in the local outbox when rollback
runs. Rollback checks that row against the archive and compares its
timestamp by instant rather than as text. The local outbox stores SQLite's
`YYYY-MM-DD HH:MM:SS` form, while the archive stores the portable ISO form
(`YYYY-MM-DDTHH:MM:SS.ffffffZ`), so both forms of the same instant match and
rollback proceeds. A malformed timestamp, or one that names a different
instant, still refuses the run.

A passive event the daemon already drained (its `processed_at` is set) can
still be listed as pending in PostgreSQL's inbox, because that inbox applies
events asynchronously. Rollback accepts such a row and leaves it as it is, so
the SQLite consumer does not replay it. A row the archive
still holds that genuinely contradicts it, for example one that is
acknowledged but not processed, refuses the run before rollback publishes
anything: the canonical database is not replaced and the same rollback can be
retried once the row is resolved.

After a drain, the replication worker deletes PostgreSQL's inbox row for each
delivered event and records that locally (`remote_pruned_at`). The archive no
longer lists such an event, and that is the normal state after a drain, so
rollback accepts the row and keeps it unchanged. It is not replayed only if its
`processed_at` was already set; the remote delivery itself applies nothing, so
a pruned row that was never processed is still promoted by the SQLite
consumer. A delivered row without that prune record, whose inbox row
PostgreSQL should still hold but the archive lacks, still refuses the run
before rollback publishes anything.

## Running it: `lcm migration rollback`

Rollback publishes its configuration and project map through the same
coordinator as activation, and it releases its PostgreSQL fence when the
publication completes, so every LCM consumer sees SQLite selected once a
rollback finishes. The operator command is
`lcm migration rollback --confirm-generation <id> --confirm-backend sqlite`; it calls the single
internal entry point, maps its seven refusal reasons to exit codes, checks that
the manifest reads `rolled-back` and runs the SQLite restart check. The runbook,
[Migration operations](migration-operations.md#rollback-and-its-limits), has the
exit table. Rollback refuses while any other project is remotely bound, because
the backend selection is global.

Run it after the grant swap, with `LCM_POSTGRES_URL` set to the daemon's
runtime-role connection and `migrationRole` still naming the schema owner;
the transfer-role URL used for activation is refused.
