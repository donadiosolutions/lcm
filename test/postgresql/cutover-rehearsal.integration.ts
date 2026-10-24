import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertHarnessReady, withPostgreSqlTestDatabase } from "./harness.js";
import { validateEvidence } from "./cutover-rehearsal/check-evidence.js";
import { captureProvenance, type Provenance } from "./cutover-rehearsal/provenance.js";
import { scenarioProblems } from "./cutover-rehearsal/semantics.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { projectMapPath } from "../../src/project-map.js";
import { readBackendPublicationJournal } from "../../src/storage/backend-publication.js";
import type { PostgreSqlPassiveEventRecord } from "../../src/storage/postgresql/passive-event-repository.js";
import {
  RehearsalCase, NO_HOME, createRole, OWNED_CHILDREN, DaemonExitedBeforeReady, roleHasNoPrivileges, addProject, readAuthority, type RehearsalHome, acknowledgeEvents, assertEventsJoined, inboxRows, recordRepresented, applyWithResponseLoss, competingLease, competingPublicationFence, staleTokenRefused, interruptActivation, type ActivationInterruption, interruptRollback, prepareGuardedWriter, type RollbackInterruption, targetConfigFor, memberGenerations, withProject, assertAllOrNoneBound, interruptSetActivation, interruptSetRollback, interruptSetPrepare, destinationProjectId, capturePartialSnapshot, expireCopyLease, killWorkerAtSeam, readEventRows, activeProfile, assertLedgerRetained, assertDaemonReplicates, replicateWithWitness, uploadResidentEvents, acknowledgeHeldGap, ledgerEntryOf, recordInstructionLedger, assertWritesRestored, assertNativeAllocationSafe, createHome, damageSnapshot, enrollProject, guardedWrite, loadManifest,
  postgresDomainDigests, provisionRole, seedNative, sha256, sqliteDomainDigests, swapGrants, unusedPort,
  withHome, writeEvidence, type DomainDigests, type ScenarioSpec,
} from "./cutover-rehearsal/fixture.js";

beforeAll(async () => {
  await assertHarnessReady();
  provenanceStart = tryCaptureProvenance();
}, 120_000);

const { manifest, sha256: manifestSha256 } = loadManifest();
const profile = activeProfile();
const only = process.env.LCM_REHEARSAL_ONLY?.split(",").filter((id) => id !== "");
const pending = manifest.scenarios.filter((spec) => spec.gate?.status === "pending").map((spec) => ({ id: spec.id, pendingOn: spec.gate!.pendingOn }));
const selected = manifest.scenarios.filter((spec) => spec.gate === undefined && spec.profiles.includes(profile) && (only === undefined || only.includes(spec.id)));
const results: Record<string, unknown>[] = [];
let database: { serverVersion: string; serverVersionNum: string } | null = null;
const homeRoots: string[] = [];

/** The tested commit and input/artifact digests bound at execution time; null where git is unavailable. */
function tryCaptureProvenance(): Provenance | null {
  try { return captureProvenance(process.cwd()); } catch { return null; }
}
let provenanceStart: Provenance | null = null;

const projectDb = (c: RehearsalCase): string => join(c.h.projectDir, "db.sqlite");

/** The shared forward flow: plan through activation, with the I1/I2/I4 oracles at each checkpoint. */
async function forward(c: RehearsalCase, expected: DomainDigests, apply = "apply"): Promise<void> {
  const plan = await c.step("plan");
  c.vars.gen = plan.envelope.generation as string;
  c.authority("before-apply");
  await c.step("dry-run");
  await c.step(apply);
  c.authority("held");
  c.sealBaseline();
  await c.step("report-copied");
  await c.step("verify");
  await c.step("verify-repeat");
  c.sealCheck("after-verify");
  await c.step("activate");
  c.authority("activated");
  c.sealCheck("after-activate");
  c.compareDomains("postgresql-after-activate", expected, await postgresDomainDigests(c.db, c.h.cwd, c.signal));
  await c.step("activate-repeat");
  await swapGrants(c.db, c.role, "runtime", c.signal);
  await c.step("report-active");
}

async function rollbackTail(c: RehearsalCase, expected: DomainDigests): Promise<void> {
  await c.step("rollback");
  c.authority("rolled-back");
  c.sealCheck("after-rollback");
  c.compareDomains("sqlite-after-rollback", expected, sqliteDomainDigests(projectDb(c)));
  assertWritesRestored(c, projectDb(c), "after-rollback");
  await c.step("report-rolled-back");
  await c.step("rollback-repeat");
}

type Handler = (c: RehearsalCase) => Promise<void>;

/** Interrupt the production activation once at a named boundary, then recover through the public commands. */
const interruptedActivation = (interruption: ActivationInterruption): Handler => async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await acknowledgeEvents(c, "f7", ["f7-ack-1", "f7-ack-2"]);
  const plan = await c.step("plan");
  c.vars.gen = plan.envelope.generation as string;
  await c.step("apply");
  c.sealBaseline();
  await c.step("verify");
  c.authority("held");
  await interruptActivation(c, interruption);
  c.authority("interrupted");
  c.sealCheck("after-interruption");
  assertLedgerRetained(c, "after-interruption");
  await c.step("report-interrupted");
  await c.step("activate-retry");
  c.authority("activated");
  c.sealCheck("after-recovery");
  c.compareDomains("postgresql-after-recovery", baseline, await postgresDomainDigests(c.db, c.h.cwd, c.signal));
  assertLedgerRetained(c, "after-recovery");
  await swapGrants(c.db, c.role, "runtime", c.signal);
  await c.step("report-active");
};


/** Clean forward flow, optionally a guarded write, then rollback; the restored SQLite must equal the destination at rollback time. */
const roundTrip = (options: { readonly write: boolean; readonly apply?: string }): Handler => async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await forward(c, baseline, options.apply);
  let expected = baseline;
  if (options.write) {
    await guardedWrite(c, "rehearsal-post-write");
    expected = await postgresDomainDigests(c.db, c.h.cwd, c.signal);
    if (expected.conversations!.count !== baseline.conversations!.count + 1) throw new Error("guarded write did not land");
  }
  await rollbackTail(c, expected);
  if (options.write) assertNativeAllocationSafe(c, projectDb(c));
};

/**
 * A post-write rollback after replication uploaded an acknowledged input that is still resident in the PostgreSQL inbox
 * (pending on the portable export refusing such rows, #1694). The rollback must succeed and retain the acknowledged input.
 */
const replicatedRoundTrip: Handler = async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await forward(c, baseline);
  await acknowledgeEvents(c, "r3r", ["r3r-resident-1"]);
  await guardedWrite(c, "rehearsal-post-write");
  const expected = await postgresDomainDigests(c.db, c.h.cwd, c.signal);
  if (expected.conversations!.count !== baseline.conversations!.count + 1) throw new Error("guarded write did not land");
  await uploadResidentEvents(c, ["r3r-resident-1"]);
  await rollbackTail(c, expected);
  assertLedgerRetained(c, "after-rollback");
  assertNativeAllocationSafe(c, projectDb(c));
};

/** Destroy a stage's outcome before it can be activated, then prove the source survives the abort. */
const damagedSnapshot = (how: "tamper" | "replace"): Handler => async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  const plan = await c.step("plan");
  c.vars.gen = plan.envelope.generation as string;
  await c.step("apply");
  c.authority("held");
  c.sealBaseline();
  damageSnapshot(c.h, c.gen, "project.sqlite", how);
  c.injections.push({ surface: "module-seam", boundary: how === "tamper" ? "sealed project.sqlite" : "sealed snapshot generation directory", kind: how === "tamper" ? "owned-file-damage" : "owned-directory-replacement", hitCount: 1 });
  await c.step("report-damaged");
  await c.step("resume-damaged");
  await c.step("abort");
  c.authority("aborted");
  c.sealCheck("after-abort", c.h, how === "tamper" ? ["project.sqlite"] : [], how === "replace");
  c.compareDomains("sqlite-after-abort", baseline, sqliteDomainDigests(projectDb(c)));
};

/**
 * Represented and retained pending receipt-era events through activation, the PostgreSQL daemon and a rollback.
 * With drain the daemon delivers once before the rollback (gated on the rollback-after-drain Bug).
 */
const eventsThroughRollback = (options: { readonly drain: boolean; readonly deliver: boolean }): Handler => async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await acknowledgeEvents(c, "f6", ["f6-represented-applied", "f6-represented-noeffect", "f6-pending"]);
  recordRepresented(c, ["f6-represented-applied", "f6-represented-noeffect"]);
  const plan = await c.step("plan");
  c.vars.gen = plan.envelope.generation as string;
  await c.step("apply");
  c.authority("held");
  c.sealBaseline();
  await c.step("verify");
  await c.step("activate");
  c.authority("activated");
  c.sealCheck("after-activate");
  assertLedgerRetained(c, "after-activate");
  c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd, c.signal));
  await swapGrants(c.db, c.role, "runtime", c.signal);
  let deliveredReceipts: readonly PostgreSqlPassiveEventRecord[] | undefined;
  if (options.drain) {
    // Inputs that exist when the one bounded drain is requested must reach PostgreSQL; the later input only has to be retained.
    const eligible = c.ledger.map((entry) => entry.data).filter((name) => !name.startsWith("f6-represented"));
    if (options.deliver) {
      deliveredReceipts = await replicateWithWitness(c, eligible);
      await assertEventsJoined(c, "after-drain", eligible, deliveredReceipts);
    }
    await c.daemon(async (daemon) => {
      const drained = await c.promote(daemon, "events-promote");
      if (drained.errors !== 0) throw new Error("the drain reported errors: " + JSON.stringify(drained));
    });
    if (!options.deliver) await assertEventsJoined(c, "after-drain", []);
    await acknowledgeEvents(c, "f6-post", ["f6-post-pending"]);
  } else {
    // No daemon runs before the rollback: its start-up sweep would deliver retained events asynchronously (#1681).
    await acknowledgeEvents(c, "f6-post", ["f6-post-pending"]);
  }
  await assertEventsJoined(c, "after-cutover");
  const represented = new Set(readEventRows(c.h).filter((row) => row.data.startsWith("f6-represented")).map((row) => row.event_uuid));
  // Represented events crossed as exactly one already-applied remote disposition each; nothing re-pended or replayed them.
  const machineId = c.ledger[0]!.machineId;
  // After a delivery pass the production replication acknowledges and prunes them: the receipts captured before that prune
  // hold the one applied disposition each, and none remains in the inbox.
  const representedStatuses: string[] = deliveredReceipts !== undefined
    ? deliveredReceipts.filter((record) => record.machineId === machineId && represented.has(record.eventId)).map((record) => record.status)
    : (await inboxRows(c.db, c.signal)).filter((row) => row.machine_id === machineId && represented.has(row.event_id)).map((row) => row.status);
  if (deliveredReceipts !== undefined && (await inboxRows(c.db, c.signal)).some((row) => represented.has(row.event_id))) {
    throw new Error("a represented event is still in the inbox after the delivery pass pruned it");
  }
  if (representedStatuses.length !== represented.size || representedStatuses.some((status) => status !== "applied")) {
    throw new Error("represented events are not exactly one applied remote disposition each: " + JSON.stringify(representedStatuses));
  }
  c.mark("I3", "represented-applied-once:" + String(represented.size));
  const pgBefore = await postgresDomainDigests(c.db, c.h.cwd, c.signal);
  await c.step("rollback");
  c.authority("rolled-back");
  assertLedgerRetained(c, "after-rollback");
  c.sealCheck("after-rollback");
  c.compareDomains("sqlite-after-rollback", pgBefore, sqliteDomainDigests(projectDb(c)));
  await c.step("report-rolled-back");
};

/** Post-write rollback interrupted once at a named boundary of the production rollback, then recovered through the public command. */
const interruptedRollback = (interruption: RollbackInterruption): Handler => async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await forward(c, baseline);
  await guardedWrite(c, "rehearsal-post-write");
  const expected = await postgresDomainDigests(c.db, c.h.cwd, c.signal);
  await interruptRollback(c, interruption);
  c.authority("rollback-interrupted");
  c.sealCheck("after-interruption");
  await c.step("report-rollback-interrupted");
  await c.step("rollback");
  c.authority("rolled-back");
  c.sealCheck("after-rollback");
  c.compareDomains("sqlite-after-rollback", expected, sqliteDomainDigests(projectDb(c)));
  assertWritesRestored(c, projectDb(c), "after-rollback");
  await c.step("report-rolled-back");
  await c.step("rollback-repeat");
};

/** Forward flow to activation, then a pre-write rollback. */
const pureRoundTrip: Handler = async (c) => {
  const expected = sqliteDomainDigests(projectDb(c));
  await forward(c, expected);
  await rollbackTail(c, expected);
};

const projectDbOf = (home: { readonly projectDir: string }): string => join(home.projectDir, "db.sqlite");
const secondOf = (c: RehearsalCase) => c.second!;

/** Both projects' native SQLite domains. */
const setBaselines = (c: RehearsalCase) => ({ a: sqliteDomainDigests(projectDb(c)), b: sqliteDomainDigests(projectDbOf(secondOf(c))) });
const setPostgres = async (c: RehearsalCase) => ({ a: await postgresDomainDigests(c.db, c.h.cwd, c.signal), b: await postgresDomainDigests(c.db, secondOf(c).cwd, c.signal) });

/** The shared forward preparation of a set through verification; returns the member generation ids. */
async function prepareSet(c: RehearsalCase): Promise<string[]> {
  const plan = await c.step("set-plan");
  c.vars.gen = plan.envelope.generation as string;
  c.authority("before-apply");
  await c.step("set-apply-dry-run");
  await c.step("set-apply");
  c.authority("held");
  const members = memberGenerations((await c.step("set-report-prepared")).envelope);
  if (members.length !== 2) throw new Error("the set did not report two members");
  c.sealBaseline(...members);
  await c.step("set-verify");
  return members;
}

const setRoundTrip: Handler = async (c) => {
  const base = setBaselines(c);
  await acknowledgeEvents(c, "s1", ["s1-pending-a"]);
  const members = await prepareSet(c);
  await c.step("set-resume-dry-run");
  await c.step("set-activate-dry-run");
  await c.step("set-activate");
  c.authority("activated");
  c.sealCheck("after-activate");
  const activated = await setPostgres(c);
  c.compareDomains("postgresql-a-after-activate", base.a, activated.a);
  c.compareDomains("postgresql-b-after-activate", base.b, activated.b);
  assertLedgerRetained(c, "after-activate");
  await swapGrants(c.db, c.role, "runtime", c.signal);
  await c.step("set-report-active");
  await c.step("set-rollback-dry-run");
  const rolledBack = (await c.step("set-rollback")).envelope.evidence as Record<string, unknown>;
  c.authority("rolled-back");
  // Two new physical generations (neither is an original member) under the one reverse publication.
  const installed = [rolledBack["member.0.installedGenerationId"], rolledBack["member.1.installedGenerationId"]];
  if (new Set(installed).size !== 2 || installed.some((id) => typeof id !== "string" || members.includes(id))) throw new Error("the rollback did not install two new generations");
  if (readBackendPublicationJournal(c.h.home)?.publicationId !== rolledBack.rollbackSetId || rolledBack.publicationId !== rolledBack.rollbackSetId) throw new Error("the members were not rolled back under one reverse publication");
  c.mark("I1", "one-reverse-publication");
  c.sealCheck("after-rollback");
  // No write followed the activation: both members come back as their exact pre-activation states.
  c.compareDomains("sqlite-a-after-rollback", base.a, sqliteDomainDigests(projectDb(c)));
  c.compareDomains("sqlite-b-after-rollback", base.b, sqliteDomainDigests(projectDbOf(secondOf(c))));
  assertLedgerRetained(c, "after-rollback");
  await c.step("set-report-rolled-back");
  await c.step("set-rollback-repeat");
};

const setPartialPreparation: Handler = async (c) => {
  const base = setBaselines(c);
  await acknowledgeEvents(c, "s2", ["s2-pending-a"]);
  const plan = await c.step("set-plan");
  c.vars.gen = plan.envelope.generation as string;
  c.authority("before-apply");
  const targetConfig = targetConfigFor(c.role);
  const outcome = await interruptSetPrepare(c, targetConfig);
  c.note("set-prepare-outcome", "module-seam", [outcome]);
  c.authority("held");
  const partial = memberGenerations((await c.step("set-report-partial")).envelope);
  c.sealBaseline(partial[0]!);
  assertLedgerRetained(c, "after-interruption");
  await c.step("set-resume");
  const members = memberGenerations((await c.step("set-report-prepared")).envelope);
  c.sealBaseline(...members);
  await c.step("set-verify");
  c.authority("held");
  // One whole-set abort: SQLite authority is restored and every source is untouched.
  await c.step("set-abort-dry-run");
  await c.step("set-abort");
  c.authority("aborted");
  c.sealCheck("after-abort");
  const after = setBaselines(c);
  c.compareDomains("sqlite-a-after-abort", base.a, after.a);
  c.compareDomains("sqlite-b-after-abort", base.b, after.b);
  assertLedgerRetained(c, "after-abort");
  await c.step("set-abort-repeat");
};

const setInterruptionChain: Handler = async (c) => {
  const base = setBaselines(c);
  await acknowledgeEvents(c, "s3", ["s3-pending-a"]);
  const members = await prepareSet(c);
  const targetConfig = targetConfigFor(c.role);
  const [a] = members as [string, string];
  const checkpoints: [string, Parameters<typeof interruptSetActivation>[1]][] = [
    ["activation-after-link", { kind: "crash-point", point: "after-link:" + a }],
    ["activation-selection-completed", { kind: "crash-point", point: "after-selection-completed" }],
    ["activation-map-published", { kind: "publication-phase", phase: "map-published" }],
    ["activation-first-member-active", { kind: "crash-point", point: "after-complete:" + a }],
  ];
  for (const [checkpoint, interruption] of checkpoints) {
    await interruptSetActivation(c, interruption, targetConfig);
    c.authority(checkpoint);
    assertAllOrNoneBound(c, 2);
    assertLedgerRetained(c, checkpoint);
    await c.step("set-report-activation-interrupted");
  }
  await c.step("set-resume-activation");
  c.authority("activated");
  c.sealCheck("after-activate");
  const activated = await setPostgres(c);
  c.compareDomains("postgresql-a-after-activate", base.a, activated.a);
  c.compareDomains("postgresql-b-after-activate", base.b, activated.b);
  await swapGrants(c.db, c.role, "runtime", c.signal);
  await c.step("set-report-active");
  await withProject(c, secondOf(c), () => guardedWrite(c, "s3-post-write-b"));
  const written = await setPostgres(c);
  const rollbacks: [string, Parameters<typeof interruptSetRollback>[1]][] = [
    ["rollback-first-install-record", { kind: "crash-point", point: "after-install-record:" + a }],
    ["rollback-map-published", { kind: "publication-phase", phase: "map-published" }],
    ["rollback-first-member-complete", { kind: "crash-point", point: "after-complete:" + a }],
  ];
  for (const [checkpoint, interruption] of rollbacks) {
    await interruptSetRollback(c, interruption);
    c.authority(checkpoint);
    assertAllOrNoneBound(c, 2);
    assertLedgerRetained(c, checkpoint);
    await c.step("set-report-rollback-interrupted");
  }
  await c.step("set-resume-rollback");
  c.authority("rolled-back");
  c.sealCheck("after-rollback");
  c.compareDomains("sqlite-a-after-rollback", written.a, sqliteDomainDigests(projectDb(c)));
  c.compareDomains("sqlite-b-after-rollback", written.b, sqliteDomainDigests(projectDbOf(secondOf(c))));
  assertWritesRestored(c, projectDbOf(secondOf(c)), "after-rollback");
  assertLedgerRetained(c, "after-rollback");
  await c.step("set-report-rolled-back");
  await c.step("set-rollback-repeat");
};

const setMemberDrift: Handler = async (c) => {
  const base = setBaselines(c);
  await acknowledgeEvents(c, "s4", ["s4-pending-a"]);
  await prepareSet(c);
  // Member B's destination moves after verification: its census no longer matches its report.
  const remoteB = await destinationProjectId(c.db, secondOf(c).cwd, c.signal);
  await c.sql("INSERT INTO lcm.conversations(project_id, session_id, title) VALUES ($1, 'drift-session', 'Drift')", [remoteB]);
  c.injections.push({ surface: "module-seam", boundary: "member B destination census after verification", kind: "destination-mutation", hitCount: 1 });
  await c.step("set-activate-drifted");
  c.authority("held");
  assertAllOrNoneBound(c, 2);
  c.sealCheck("after-refusal");
  assertLedgerRetained(c, "after-refusal");
  await c.step("set-report-prepared-drifted");
  await c.step("set-abort");
  c.authority("aborted");
  c.sealCheck("after-abort");
  const after = setBaselines(c);
  c.compareDomains("sqlite-a-after-abort", base.a, after.a);
  c.compareDomains("sqlite-b-after-abort", base.b, after.b);
  assertLedgerRetained(c, "after-abort");
};

const setRollbackInstallFailure: Handler = async (c) => {
  const base = setBaselines(c);
  await acknowledgeEvents(c, "s4b", ["s4b-pending-a"]);
  await prepareSet(c);
  await c.step("set-activate");
  c.authority("activated");
  const activated = await setPostgres(c);
  c.compareDomains("postgresql-a-after-activate", base.a, activated.a);
  c.compareDomains("postgresql-b-after-activate", base.b, activated.b);
  await swapGrants(c.db, c.role, "runtime", c.signal);
  await withProject(c, secondOf(c), () => guardedWrite(c, "s4b-post-write-b"));
  const written = await setPostgres(c);
  const outcome = await interruptSetRollback(c, { kind: "install-failure" });
  c.note("set-rollback-outcome", "module-seam", [outcome]);
  c.authority("rollback-blocked");
  assertAllOrNoneBound(c, 2);
  assertLedgerRetained(c, "after-install-failure");
  await c.step("set-report-rollback-blocked");
  await c.step("set-rollback");
  c.authority("rolled-back");
  c.sealCheck("after-rollback");
  c.compareDomains("sqlite-a-after-rollback", written.a, sqliteDomainDigests(projectDb(c)));
  c.compareDomains("sqlite-b-after-rollback", written.b, sqliteDomainDigests(projectDbOf(secondOf(c))));
  assertWritesRestored(c, projectDbOf(secondOf(c)), "after-rollback");
  assertLedgerRetained(c, "after-rollback");
  await c.step("set-report-rolled-back");
};

/**
 * Events around the hold. With deliver, the inputs that exist at the drain reach PostgreSQL through the production replication
 * worker driven in process (receipts captured before the prune), and one more input acknowledged afterwards is left for the
 * daemon: its own start-up sweep must deliver it.
 */
const eventsAroundHold = (options: { readonly deliver: boolean }): Handler => async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await acknowledgeEvents(c, "f5-pre", ["f5-pre-1", "f5-pre-2"]);
  const plan = await c.step("plan");
  c.vars.gen = plan.envelope.generation as string;
  await c.step("apply");
  c.authority("held");
  c.sealBaseline();
  // The held gap: the local durable enqueue is open during the hold. The only allowed refusal is the closed
  // LocalHookDurabilityTimeoutError (nothing acknowledged); any other failure, including a ledger readback error, fails the row.
  const gap = await acknowledgeHeldGap(c, "f5-gap", ["f5-gap-1"]);
  c.mark("I3", "hold-gap-append:" + gap);
  await c.step("verify");
  assertLedgerRetained(c, "after-verify");
  await c.step("activate");
  c.authority("activated");
  c.sealCheck("after-activate");
  assertLedgerRetained(c, "after-activate");
  c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd, c.signal));
  await swapGrants(c.db, c.role, "runtime", c.signal);
  await acknowledgeEvents(c, "f5-post", ["f5-post-1"]);
  const eligible = c.ledger.map((entry) => entry.data);
  if (options.deliver) await assertEventsJoined(c, "after-drain", eligible, await replicateWithWitness(c, eligible));
  if (options.deliver) await acknowledgeEvents(c, "f5-daemon", ["f5-daemon-1"]);
  await c.daemon(async (daemon) => {
    // One bounded awaited drain request; the daemon's own sweep may already have delivered some inputs.
    const drained = await c.promote(daemon, "events-promote");
    if (drained.errors !== 0) throw new Error("the drain reported errors: " + JSON.stringify(drained));
    if (options.deliver) await assertDaemonReplicates(c, daemon, "f5-daemon-1");
  });
  await assertEventsJoined(c, options.deliver ? "after-daemon-sweep" : "after-drain", []);
};

/**
 * A SQLite daemon left running across the cutover: restart-required until it is stopped; then one input is delivered by the
 * production replication worker in process (receipts captured before the prune) and a second one by the restarted PostgreSQL
 * daemon's own start-up sweep.
 */
const staleDaemonCutover = (options: { readonly targetEnv: boolean }): Handler => async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  // The stale daemon keeps whatever environment it was started with while the config still selected SQLite. With the PostgreSQL
  // connection variables present the observe route answers (#1683); without them it does not yet (#1696, F10-no-target-env).
  const sqliteEnv = options.targetEnv ? c.h.env : Object.fromEntries(Object.entries(c.h.env).filter(([name]) => name !== "LCM_POSTGRES_URL" && name !== "LCM_POSTGRES_CA_FILE"));
  const sourceBefore = sha256(readFileSync(projectDb(c)));
  await c.daemon(async (daemon) => {
    if ((daemon.health as { storageBackend?: string }).storageBackend !== "sqlite") throw new Error("the old daemon did not start on SQLite");
    const plan = await c.step("plan");
    c.vars.gen = plan.envelope.generation as string;
    await c.step("apply");
    c.authority("held");
    c.sealBaseline();
    await c.step("verify");
    await c.step("activate");
    c.authority("activated");
    await c.step("report-restart-required");
  }, { env: sqliteEnv as NodeJS.ProcessEnv });
  c.sealCheck("after-old-daemon-stop");
  c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd, c.signal));
  await swapGrants(c.db, c.role, "runtime", c.signal);
  // A hook input acknowledged after the old daemon stopped is retained by the sidecar and reaches PostgreSQL exactly once
  // through the production replication (driven in process, where the prune is observable). A second input is left undelivered:
  // the restarted daemon starts on PostgreSQL, answers the restart verifier, and its own start-up sweep must deliver it.
  await acknowledgeEvents(c, "f10-post", ["f10-post-1"]);
  await assertEventsJoined(c, "after-restart-drain", ["f10-post-1"], await replicateWithWitness(c, ["f10-post-1"]));
  await acknowledgeEvents(c, "f10-daemon", ["f10-post-2"]);
  await c.daemon(async (daemon) => {
    if ((daemon.health as { storageBackend?: string }).storageBackend !== "postgresql") throw new Error("the restarted daemon did not start on PostgreSQL");
    await c.step("report-active");
    c.mark("I1", "restarted-daemon-health:postgresql");
    await assertDaemonReplicates(c, daemon, "f10-post-2");
  });
  await assertEventsJoined(c, "after-daemon-sweep");
  // Neither daemon wrote the SQLite project database after the cutover.
  if (sha256(readFileSync(projectDb(c))) !== sourceBefore) throw new Error("a daemon wrote the SQLite project database");
  c.mark("I2", "sqlite-project-database-unchanged");
};

const handlers: Record<string, Handler> = {
  "S1": setRoundTrip,
  "S2": setPartialPreparation,
  "S3": setInterruptionChain,
  "S4": setMemberDrift,
  "S4b": setRollbackInstallFailure,
  "F1-empty": pureRoundTrip,
  "F1-empty-project": pureRoundTrip,
  "F1-representative": async (c) => {
    const expected = sqliteDomainDigests(projectDb(c));
    await forward(c, expected);
    const sourceBefore = sha256(await import("node:fs").then((fs) => fs.readFileSync(projectDb(c))));
    await c.daemon(async (daemon) => {
      if ((daemon.health as { storageBackend?: string }).storageBackend !== "postgresql") throw new Error("daemon started on the wrong backend");
      await c.step("report-daemon");
      c.mark("I1", "daemon-health:postgresql");
    });
    // Consumer admission is read once the daemon has stopped: its start-up sweep holds the publication lock for a moment.
    c.authority("after-daemon");
    const sourceAfter = sha256(await import("node:fs").then((fs) => fs.readFileSync(projectDb(c))));
    if (sourceBefore !== sourceAfter) throw new Error("the daemon wrote the SQLite project database");
    c.sealCheck("after-daemon");
  },
  "F2": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    await acknowledgeEvents(c, "f2", ["f2-ack-1", "f2-ack-2"]);
    const plan = await c.step("plan");
    c.vars.gen = plan.envelope.generation as string;
    c.authority("before-apply");
    const killed = await killWorkerAtSeam(c, "after-batch-readback");
    if (killed.signal !== "SIGKILL" || killed.generationId !== c.gen) throw new Error("worker was not killed at the seam for this generation");
    c.note("kill-worker", "module-seam", ["after-batch-readback", "SIGKILL"]);
    c.authority("after-kill");
    c.sealBaseline();
    await c.step("report-killed");
    assertLedgerRetained(c, "after-kill");
    if (await expireCopyLease(c.db, c.signal) !== 1) throw new Error("expected exactly one dead copy lease");
    await c.step("resume");
    c.authority("held");
    await c.step("report-copied");
    await c.step("verify");
    await c.step("verify-repeat");
    c.sealCheck("after-verify");
    await c.step("activate");
    c.authority("activated");
    c.sealCheck("after-activate");
    c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd, c.signal));
    assertLedgerRetained(c, "after-activate");
    await swapGrants(c.db, c.role, "runtime", c.signal);
    await c.step("report-active");
  },
  "F7a": interruptedActivation({ kind: "crash-point", point: "after-prepare-complete" }),
  "F7b": interruptedActivation({ kind: "crash-point", point: "after-selection-prepared" }),
  "F7c": interruptedActivation({ kind: "publication-phase", phase: "map-published" }),
  "F7d": interruptedActivation({ kind: "crash-point", point: "after-drive" }),
  "F8": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    const plan = await c.step("plan");
    c.vars.gen = plan.envelope.generation as string;
    await c.step("apply");
    c.authority("held");
    c.sealBaseline();
    // Another actor owns the verification fence: verify is refused as contention and nothing is begun.
    const verification = await competingLease(c, "migration-verification", c.gen);
    await c.step("verify-contended");
    await c.step("report-copied");
    c.authority("held");
    await verification.release();
    await c.step("verify");
    // Another actor owns the publication fence: activation is refused as contention and nothing is published.
    const publication = await competingPublicationFence(c);
    await c.step("activate-contended");
    c.authority("verified-contended");
    c.sealCheck("after-contention");
    await publication.release();
    // A superseded fencing token is refused by the fence after a takeover; the destination data is untouched by it.
    const tokens = await staleTokenRefused(c);
    c.note("stale-token-takeover", "module-seam", ["rehearsal-fence", tokens.stale + "<" + tokens.current]);
    c.injections.push({ surface: "module-seam", boundary: "lease takeover", kind: "stale-fencing-token", hitCount: 1 });
    await c.step("activate");
    c.authority("activated");
    c.sealCheck("after-activate");
    c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd, c.signal));
  },
  "F3": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    await acknowledgeEvents(c, "f3", ["f3-ack-1", "f3-ack-2"]);
    const plan = await c.step("plan");
    c.vars.gen = plan.envelope.generation as string;
    c.authority("before-apply");
    const loss = await applyWithResponseLoss(c);
    if (!loss.lost) throw new Error("the response-loss injection never fired");
    if (loss.status !== "copied") throw new Error("copy did not settle the lost response positively: " + loss.status);
    c.authority("held");
    c.sealBaseline();
    // One logical disposition per batch: no duplicate receipt for the batch whose response was lost.
    const batches = await c.sql("SELECT count(*)::int AS n, count(DISTINCT (domain, first_ordinal))::int AS distinct_first FROM lcm.transfer_batches");
    if (batches[0]!.n !== batches[0]!.distinct_first) throw new Error("a copy batch was recorded more than once");
    c.mark("I3", "receipts:" + String(batches[0]!.n));
    await c.step("report-copied");
    await c.step("verify");
    await c.step("activate");
    c.authority("activated");
    c.sealCheck("after-activate");
    c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd, c.signal));
    assertLedgerRetained(c, "after-activate");
    await swapGrants(c.db, c.role, "runtime", c.signal);
    await c.step("report-active");
  },
  "F10": staleDaemonCutover({ targetEnv: true }),
  "F10-no-target-env": staleDaemonCutover({ targetEnv: false }),
  "F5": eventsAroundHold({ deliver: false }),
  "F5-delivery": eventsAroundHold({ deliver: true }),
  "F6": eventsThroughRollback({ drain: false, deliver: false }),
  "F6b": eventsThroughRollback({ drain: true, deliver: false }),
  "F6b-delivery": eventsThroughRollback({ drain: true, deliver: true }),
  "R6a": interruptedRollback({ kind: "after-install-sync" }),
  "R6b": interruptedRollback({ kind: "publication-phase", phase: "map-published" }),
  "R5": async (c) => {
    // F6's queue through an interrupted rollback: represented rows are not replayed, pending rows survive, nothing is acknowledged twice.
    const baseline = sqliteDomainDigests(projectDb(c));
    await acknowledgeEvents(c, "r5", ["r5-represented-applied", "r5-represented-noeffect", "r5-pending"]);
    recordRepresented(c, ["r5-represented-applied", "r5-represented-noeffect"]);
    await forward(c, baseline);
    await acknowledgeEvents(c, "r5-post", ["r5-post-pending"]);
    await guardedWrite(c, "rehearsal-post-write");
    const expected = await postgresDomainDigests(c.db, c.h.cwd, c.signal);
    await interruptRollback(c, { kind: "before-complete-selection" });
    c.authority("rollback-interrupted");
    assertLedgerRetained(c, "after-interruption");
    await c.step("report-rollback-interrupted");
    await c.step("rollback");
    c.authority("rolled-back");
    assertLedgerRetained(c, "after-rollback");
    c.sealCheck("after-rollback");
    c.compareDomains("sqlite-after-rollback", expected, sqliteDomainDigests(projectDb(c)));
    assertWritesRestored(c, projectDb(c), "after-rollback");
    await c.step("report-rolled-back");
    const rows = readEventRows(c.h);
    const acknowledged = rows.filter((row) => row.delivery_state === "acknowledged").length;
    c.mark("I3", "post-rollback-local-rows:" + String(rows.length) + ",acknowledged:" + String(acknowledged));
  },
  "R4": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    await forward(c, baseline);
    const write = await prepareGuardedWriter(c);
    let refused = false;
    const outcome = await interruptRollback(c, {
      kind: "around-fence",
      beforeOpen: () => write("rehearsal-before-fence"),
      afterOpen: async () => { try { await write("rehearsal-after-fence"); } catch { refused = true; } },
    });
    if (!refused) throw new Error("a canonical writer was admitted after the rollback fence");
    c.mark("I1", "writer-after-fence-refused");
    c.note("rollback-with-fence-adjacent-writers", "module-seam", [outcome]);
    if (outcome !== "returned:rolled-back") throw new Error("rollback with a writer before the fence did not complete: " + outcome);
    c.authority("rolled-back");
    c.sealCheck("after-rollback");
    const restored = sqliteDomainDigests(projectDb(c));
    if (restored.conversations!.count !== baseline.conversations!.count + 1) throw new Error("the write before the fence was not carried by the rollback");
    // Exact content, not just the count: the restored SQLite equals the destination that carried the write.
    c.compareDomains("sqlite-after-rollback", await postgresDomainDigests(c.db, c.h.cwd, c.signal), restored);
    assertWritesRestored(c, projectDb(c), "after-rollback");
    c.mark("I4", "write-before-fence-carried");
    await c.step("report-rolled-back");
    await c.step("rollback-repeat");
  },
  "L1": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    await forward(c, baseline);
    await guardedWrite(c, "rehearsal-post-write");
    const before = await postgresDomainDigests(c.db, c.h.cwd, c.signal);
    await interruptRollback(c, { kind: "before-complete-selection" });
    c.authority("rollback-interrupted");
    // Out-of-band, unguarded destination change after the selection was prepared.
    await c.sql("UPDATE lcm.messages SET content = 'l1-out-of-band' WHERE ctid = (SELECT ctid FROM lcm.messages LIMIT 1)");
    c.injections.push({ surface: "module-seam", boundary: "unguarded destination change after the prepared selection", kind: "destination-mutation", hitCount: 1 });
    await c.step("rollback-drift");
    await c.step("rollback-drift-again");
    await c.step("abort-refused");
    c.authority("rollback-interrupted");
    c.sealCheck("after-refusals");
    const after = await postgresDomainDigests(c.db, c.h.cwd, c.signal);
    if (after.messages!.count !== before.messages!.count || after.messages!.sha256 === before.messages!.sha256) throw new Error("the destination did not keep exactly the out-of-band change");
    c.mark("I4", "destination-retained-with-injected-drift");
  },
  "R1": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    const plan = await c.step("plan");
    c.vars.gen = plan.envelope.generation as string;
    c.authority("before-apply");
    await c.step("apply");
    c.authority("held");
    c.sealBaseline();
    await c.step("verify");
    await c.step("rollback");
    c.authority("held");
    c.sealCheck("after-refusal");
    await c.step("abort");
    c.authority("aborted");
    await c.step("abort-repeat");
    c.compareDomains("sqlite-after-abort", baseline, sqliteDomainDigests(projectDb(c)));
  },
  "R2": roundTrip({ write: false }),
  "R3": roundTrip({ write: true }),
  "R3-replicated": replicatedRoundTrip,
  "F1-alias": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    await forward(c, baseline);
    const aliases = await c.sql("SELECT count(*)::int AS n, count(DISTINCT project_id)::int AS projects FROM lcm.project_aliases");
    if (aliases[0]!.projects !== 1) throw new Error("aliases produced more than one destination project");
    c.mark("I4", "alias-rows:" + String(aliases[0]!.n));
    await rollbackTail(c, baseline);
    const map = JSON.parse(readFileSync(projectMapPath(c.h.home), "utf8")) as Record<string, { aliases: string[] }>;
    if (map[c.h.localProjectId]!.aliases.length !== 128) throw new Error("alias set not restored by rollback");
  },
  "F1-large": roundTrip({ write: true, apply: "apply" }),
  "F4": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    const plan = await c.step("plan");
    c.vars.gen = plan.envelope.generation as string;
    await c.step("apply");
    c.authority("held");
    c.sealBaseline();
    await c.sql("UPDATE lcm.messages SET content = 'rehearsal-tampered' WHERE ctid = (SELECT ctid FROM lcm.messages LIMIT 1)");
    c.injections.push({ surface: "module-seam", boundary: "destination message content", kind: "destination-mutation", hitCount: 1 });
    await c.step("verify");
    await c.step("activate");
    await c.step("report-copied");
    c.authority("held");
    await c.step("abort");
    c.authority("aborted");
    c.sealCheck("after-abort");
    c.compareDomains("sqlite-after-abort", baseline, sqliteDomainDigests(projectDb(c)));
  },
  "F11-tampered": damagedSnapshot("tamper"),
  "F11-replaced": damagedSnapshot("replace"),
  "F1-legacy": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    const plan = await c.step("plan");
    c.vars.gen = plan.envelope.generation as string;
    c.authority("before-apply");
    await c.step("apply");
    c.authority("after-refusal");
    c.sealBaseline();
    await c.step("report-held");
    assertLedgerRetained(c, "after-refusal");
    await c.step("abort");
    c.authority("aborted");
    c.sealCheck("after-abort");
    c.compareDomains("sqlite-after-abort", baseline, sqliteDomainDigests(projectDb(c)));
    assertLedgerRetained(c, "after-abort");
  },
};

/** A second registered installation (own HOME, machine identity and project) beside the migrated home A. */
async function secondInstallation(c: RehearsalCase, label: string, shared: boolean): Promise<{ readonly one: RehearsalHome; readonly two: RehearsalHome }> {
  const one = createHome(label, c.role, await unusedPort(), "b-project-one");
  c.extraHomes.push(one);
  const two = addProject(one, "b-project-two");
  await withHome(one.home, async () => { await enrollProject(one, c.role); await enrollProject(two, c.role); });
  seedNative(one, { withParts: true });
  seedNative(two, { conversations: 1, messagesPerConversation: 2, rich: false });
  void shared;
  return { one, two };
}

const installationDigests = (homes: readonly RehearsalHome[]): string[] => homes.map((home) => JSON.stringify(sqliteDomainDigests(projectDbOf(home))));

const handlersMore: Record<string, Handler> = {
  "F9": async (c) => {
    const baseA = sqliteDomainDigests(projectDb(c));
    const { one, two } = await secondInstallation(c, "f9b", false);
    const before = installationDigests([one, two]);
    const authorityB = readAuthority(one);
    // Installation B is registered against the same PostgreSQL but no daemon of it runs; A migrates on its own.
    await forward(c, baseA);
    await rollbackTail(c, baseA);
    if (JSON.stringify(installationDigests([one, two])) !== JSON.stringify(before)) throw new Error("installation B's SQLite changed");
    if (JSON.stringify(readAuthority(one)) !== JSON.stringify(authorityB)) throw new Error("installation B's authority changed");
    c.note("operator-quiescence-scope", "documentation", ["docs/migration-operations.md:810-824", "no exclusion is claimed across installations"]);
    c.mark("I1", "installation-b-authority-unchanged");
    c.mark("I4", "installation-b-sqlite-unchanged");
  },
  "H2": async (c) => {
    const baseA = sqliteDomainDigests(projectDb(c));
    const { one, two } = await secondInstallation(c, "h2b", true);
    await forward(c, baseA);
    const remote = await destinationProjectId(c.db, c.h.cwd, c.signal);
    // Installation B is bound to the shared destination project (the durable state a PostgreSQL link leaves in its project map)
    // while it selects SQLite and holds its own history.
    writeFileSync(projectMapPath(one.home), JSON.stringify({ [one.localProjectId]: { canonical: one.cwd, aliases: [], remoteProjectId: remote } }) + "\n", { mode: 0o600 });
    c.note("bind-shared-project", "module-seam", ["installation-b project map binds the shared destination project"]);
    const before = installationDigests([one, two]);
    // Installation B's operator prepares its own migration: the transfer grants are back for that run.
    await swapGrants(c.db, c.role, "transfer", c.signal);
    const bPlan = await c.step("b-plan", one);
    c.vars.gen = bPlan.envelope.generation as string;
    await c.step("b-apply", one);
    await c.step("b-set-plan", one);
    await c.step("b-set-apply", one);
    c.authority("b-sqlite", one);
    if (JSON.stringify(installationDigests([one, two])) !== JSON.stringify(before)) throw new Error("installation B's SQLite changed");
    c.mark("I4", "installation-b-history-preserved");
  },
};
handlersMore["F11-partial"] = async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await acknowledgeEvents(c, "f11p", ["f11p-ack-1"]);
  const plan = await c.step("plan");
  c.vars.gen = plan.envelope.generation as string;
  await capturePartialSnapshot(c);
  c.authority("held");
  await c.step("report-partial");
  await c.step("apply-partial");
  await c.step("resume-partial");
  assertLedgerRetained(c, "after-refusals");
  await c.step("abort");
  c.authority("aborted");
  c.compareDomains("sqlite-after-abort", baseline, sqliteDomainDigests(projectDb(c)));
  assertLedgerRetained(c, "after-abort");
};
handlersMore["I5"] = async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await forward(c, baseline);
  const sourceBefore = sha256(readFileSync(projectDb(c)));
  const databasesBefore = readdirSync(join(c.h.home, ".lcm", "projects")).sort();
  // Only this row's owned role loses its permission: the selected PostgreSQL becomes unusable for the operator.
  await swapGrants(c.db, c.role, "none", c.signal);
  let classification = "";
  try {
    c.injections.push({ surface: "module-seam", boundary: "owned role permission revoked after selection", kind: "unreachable-target", hitCount: 1 });
    if (!await roleHasNoPrivileges(c.db, c.role, c.signal)) throw new Error("the owned role still holds privileges on the selected schema");
    await c.step("report-unreachable");
    // The closed, sanitized classification comes from the child: the product's own backend diagnostic names the selected
    // PostgreSQL's failure class (a structured SQLSTATE mapping, no message text).
    const diagnostics = await c.rawCli("stats-unreachable", ["stats", "--pool", "--json"], 0);
    const snapshot = diagnostics.backendDiagnostics as { backend?: string; classification?: string } | undefined;
    if (snapshot?.backend !== "postgresql" || snapshot.classification !== "permission-denied") {
      throw new Error("the diagnostic did not classify the failure as a PostgreSQL permission denial: " + JSON.stringify({ backend: snapshot?.backend, classification: snapshot?.classification }));
    }
    classification = "postgresql:" + snapshot.classification;
    // The daemon must refuse to start by exiting on its own. A timeout, a disclosure, a surviving process group or a
    // listening port still fails the row (they throw from the daemon harness); a healthy daemon fails it here.
    let refusal: string | null = null;
    try {
      await c.daemon(async () => { throw new Error("the daemon became healthy against a target it cannot use"); });
    } catch (error) {
      if (!(error instanceof DaemonExitedBeforeReady) || error.exitCode === null || error.exitCode === 0) throw error;
      refusal = "daemon-exited-before-ready:" + String(error.exitCode);
    }
    if (refusal === null) throw new Error("no start refusal was observed");
    c.note("daemon-start-unreachable", "cli", [refusal]);
    c.authority("activated");
    if (sha256(readFileSync(projectDb(c))) !== sourceBefore) throw new Error("a canonical write reached the SQLite project database");
    if (JSON.stringify(readdirSync(join(c.h.home, ".lcm", "projects")).sort()) !== JSON.stringify(databasesBefore)) throw new Error("a new project database appeared");
    c.mark("I5", "permission-denied-classification:" + classification + ",start-refusal:" + refusal);
  } finally {
    await swapGrants(c.db, c.role, "runtime", c.signal);
  }
  await c.step("report-active-restored");
};
Object.assign(handlers, handlersMore);

/** Per-fixture preparation; every row starts from a real enrolled, natively seeded home. */
async function prepare(c: RehearsalCase): Promise<void> {
  const fixture = c.spec.fixture;
  if (fixture === "L") {
    // Hook events acknowledged before the machine is enrolled: one processed, one pending.
    await withHome(c.h.home, () => appendLocalHookEvents({
      cwd: c.h.cwd, sessionId: "legacy-session", sourceHook: "SessionStart",
      events: ["legacy-processed", "legacy-pending"].map((data) => ({ type: "decision", category: "decision", data, priority: 1 })),
    }));
    const events = new DatabaseSync(join(c.h.home, ".lcm", "events", c.h.localProjectId + ".db"));
    try { events.exec("UPDATE events SET processed_at = datetime('now') WHERE data = 'legacy-processed'"); } finally { events.close(); }
    c.ledger.push(...readEventRows(c.h).map((row) => ledgerEntryOf(c.h, row)));
  }
  if (fixture === "A") {
    const aliases = Array.from({ length: manifest.workload.bounds.aliasFixture.aliasPathsPerProject }, (_unused, index) => join(c.h.root, "alias", "worktree-" + String(index).padStart(3, "0")));
    writeFileSync(projectMapPath(c.h.home), JSON.stringify({ [c.h.localProjectId]: { canonical: c.h.cwd, aliases } }) + "\n", { mode: 0o600 });
  }
  if (fixture === "PM") writeFileSync(projectMapPath(c.h.home), JSON.stringify({ [c.h.localProjectId]: { canonical: c.h.cwd, aliases: [] } }) + "\n", { mode: 0o600 });
  await withHome(c.h.home, () => enrollProject(c.h, c.role));
  if (fixture === "M") {
    const second = addProject(c.h, "project-b");
    c.second = second;
    await withHome(c.h.home, () => enrollProject(second, c.role));
    seedNative(second, { conversations: 1, messagesPerConversation: 2, rich: false });
  }
  switch (fixture) {
    case "M": seedNative(c.h, { withParts: true }); break;
    case "E": seedNative(c.h, { conversations: 1, messagesPerConversation: 1, rich: false }); break;
    case "P": case "PM": case "L": seedNative(c.h, { withParts: true }); break;
    case "A": seedNative(c.h, { withParts: true, tiedTimestamps: true }); break;
    case "B": {
      const large = manifest.workload.bounds.largeFixture;
      const planned = large.conversations + large.conversations * large.messagesPerConversation * 2 + large.otherRecords;
      if (planned !== large.plannedRecords || planned > large.maxPortableRecords) throw new Error("large fixture violates the declared workload bounds");
      seedNative(c.h, { conversations: large.conversations, messagesPerConversation: large.messagesPerConversation, withParts: true });
      break;
    }
    case "E0": break;
    default: throw new Error("unknown fixture " + fixture);
  }
  if (fixture !== "E" && fixture !== "E0") recordInstructionLedger(c);
}

/** Time kept back from a row's Vitest timeout so cancellation and cleanup finish before the row is abandoned. */
const CLEANUP_MARGIN_MS = 60_000;
/** The part of the margin cleanup may spend on its own queries; the rest absorbs process-group closes. */
const CLEANUP_QUERY_BUDGET_MS = 45_000;

async function runScenario(spec: ScenarioSpec, index: number): Promise<void> {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new Error("scenario execution budget spent: " + spec.id)), Math.max(1_000, spec.timeoutMs - CLEANUP_MARGIN_MS));
  try {
    await withPostgreSqlTestDatabase("rh" + String(index), async (db) => {
      // The role is owned from the moment CREATE ROLE succeeds, and the case exists before any home does, so a failure
      // anywhere in setup still drops the role, removes whatever exists and records the row's I6.
      const role = await createRole(db, budget.signal);
      const c = new RehearsalCase(spec, manifest, db, role, NO_HOME);
      c.signal = budget.signal;
      let failure: string | undefined;
      let problems: string[] = [];
      try {
        await provisionRole(db, role, budget.signal);
        c.checkpoint();
        if (database === null) {
          const observed = await c.sql("SELECT version() AS version, current_setting('server_version_num') AS number");
          database = { serverVersion: String(observed[0]!.version), serverVersionNum: String(observed[0]!.number) };
        }
        const port = await unusedPort();
        c.checkpoint();
        c.h = createHome(spec.id, role, port);
        c.daemonPort = port;
        await prepare(c);
        c.checkpoint();
        const handler = handlers[spec.id];
        if (handler === undefined) throw new Error("no handler for manifest row " + spec.id);
        await handler(c);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        // Evidence is finalized once, after cleanup on its own bounded budget, and survives a failure or a cleanup problem.
        try { await c.cleanup(AbortSignal.timeout(CLEANUP_QUERY_BUDGET_MS)); } catch (error) { c.cleanupProblems.push("cleanup threw: " + (error instanceof Error ? error.name : "error")); }
        const final = c.record(failure);
        problems = final.problems;
        homeRoots.push(...c.homeRoots);
        results.push(final.record);
        writeEvidence("scenarios/" + spec.id + ".json", final.record);
      }
      if (problems.length > 0) throw new Error("required invariants did not pass for " + spec.id + ": " + problems.join("; "));
    });
  } finally {
    clearTimeout(timer);
  }
}

selected.forEach((spec, index) => {
  it(spec.id + ": " + spec.title, () => runScenario(spec, index), spec.timeoutMs);
});

afterAll(() => {
  const missing = selected.filter((spec) => !results.some((record) => record.id === spec.id)).map((spec) => spec.id);
  const allHomesAbsent = results.length > 0 && results.every((record) => (record.invariants as Record<string, { status: string }>).I6?.status === "pass");
  const finished = tryCaptureProvenance();
  const expectedRows = manifest.scenarios.filter((spec) => spec.gate === undefined && spec.profiles.includes(profile)).map((spec) => spec.id);
  const unchanged = provenanceStart !== null && finished !== null
    && provenanceStart.testedInputsSha256 === finished.testedInputsSha256 && provenanceStart.cliSha256 === finished.cliSha256 && provenanceStart.testedCommit === finished.testedCommit;
  const aggregate = {
    schemaVersion: 1, manifestSha256, profile, workers: 1, focused: only !== undefined,
    runtime: process.env.LCM_TEST_CONTAINER_CLI ?? null, runId: process.env.LCM_TEST_POSTGRES_RUN_ID ?? null,
    expectedRows, selection: selected.map((spec) => spec.id), pending, missing,
    ...(database === null ? {} : { database }),
    provenance: provenanceStart === null ? null : { ...provenanceStart, unchangedAfterRun: unchanged },
    ownedProcesses: [...OWNED_CHILDREN], homeRoots,
    scenarios: results, cleanup: { scenarioHomes: allHomesAbsent ? "verified-absent" : "incomplete", harnessResources: "pending-outer-audit" }, verdict: "incomplete",
  };
  writeEvidence("rehearsal.json", aggregate);
  // The serialized record must conform to the committed schema (the supported subset check).
  const schema = JSON.parse(readFileSync(join(process.cwd(), "test/postgresql/cutover-rehearsal/evidence-schema.json"), "utf8")) as Record<string, unknown>;
  expect(validateEvidence(schema, JSON.parse(JSON.stringify(aggregate)) as unknown, "#/$defs/rehearsal")).toEqual([]);
  // Membership is judged against the checked-in manifest, never against the (possibly filtered) selection.
  expect(new Set(results.map((record) => record.id)).size).toBe(results.length);
  if (only === undefined) expect([...results.map((record) => record.id as string)].sort()).toEqual([...expectedRows].sort());
  else expect(selected.every((spec) => expectedRows.includes(spec.id))).toBe(true);
  const semantic = results.flatMap((record) => scenarioProblems(record as unknown as Parameters<typeof scenarioProblems>[0], manifest.scenarios.find((spec) => spec.id === record.id) as unknown as Parameters<typeof scenarioProblems>[1]));
  expect(semantic).toEqual([]);
  if (provenanceStart !== null) expect(unchanged).toBe(true);
  if (profile === "full" && only === undefined) expect(provenanceStart).not.toBeNull();
  expect(missing).toEqual([]);
});
