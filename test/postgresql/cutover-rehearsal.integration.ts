import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertHarnessReady, withPostgreSqlTestDatabase } from "./harness.js";
import { validateEvidence } from "./cutover-rehearsal/check-evidence.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { projectMapPath } from "../../src/project-map.js";
import {
  RehearsalCase, addProject, readAuthority, type RehearsalHome, acknowledgeEvents, assertEventsJoined, inboxRows, recordRepresented, applyWithResponseLoss, competingLease, competingPublicationFence, staleTokenRefused, interruptActivation, type ActivationInterruption, interruptRollback, prepareGuardedWriter, type RollbackInterruption, targetConfigFor, memberGenerations, withProject, assertAllOrNoneBound, interruptSetActivation, interruptSetRollback, interruptSetPrepare, destinationProjectId, capturePartialSnapshot, expireCopyLease, killWorkerAtSeam, envelopeHash, readEventRows, activeProfile, adminSql, assertLedgerRetained, createHome, damageSnapshot, enrollProject, guardedWrite, loadManifest,
  postgresDomainDigests, provisionRole, seedNative, sha256, sqliteDomainDigests, swapGrants, unusedPort,
  withHome, writeEvidence, type DomainDigests, type ScenarioSpec,
} from "./cutover-rehearsal/fixture.js";

beforeAll(assertHarnessReady, 120_000);

const { manifest, sha256: manifestSha256 } = loadManifest();
const profile = activeProfile();
const only = process.env.LCM_REHEARSAL_ONLY?.split(",").filter((id) => id !== "");
const pending = manifest.scenarios.filter((spec) => spec.gate?.status === "pending").map((spec) => ({ id: spec.id, pendingOn: spec.gate!.pendingOn }));
const selected = manifest.scenarios.filter((spec) => spec.gate === undefined && spec.profiles.includes(profile) && (only === undefined || only.includes(spec.id)));
const results: Record<string, unknown>[] = [];
let database: { serverVersion: string; serverVersionNum: string } | null = null;

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
  c.compareDomains("postgresql-after-activate", expected, await postgresDomainDigests(c.db, c.h.cwd));
  await c.step("activate-repeat");
  await swapGrants(c.db, c.role, "runtime");
  await c.step("report-active");
}

async function rollbackTail(c: RehearsalCase, expected: DomainDigests): Promise<void> {
  await c.step("rollback");
  c.authority("rolled-back");
  c.sealCheck("after-rollback");
  c.compareDomains("sqlite-after-rollback", expected, sqliteDomainDigests(projectDb(c)));
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
  c.compareDomains("postgresql-after-recovery", baseline, await postgresDomainDigests(c.db, c.h.cwd));
  assertLedgerRetained(c, "after-recovery");
  await swapGrants(c.db, c.role, "runtime");
  await c.step("report-active");
};


/** Clean forward flow, optionally a guarded write, then rollback; the restored SQLite must equal the destination at rollback time. */
const roundTrip = (options: { readonly write: boolean; readonly apply?: string }): Handler => async (c) => {
  const baseline = sqliteDomainDigests(projectDb(c));
  await forward(c, baseline, options.apply);
  let expected = baseline;
  if (options.write) {
    await guardedWrite(c, "rehearsal-post-write");
    expected = await postgresDomainDigests(c.db, c.h.cwd);
    if (expected.conversations!.count !== baseline.conversations!.count + 1) throw new Error("guarded write did not land");
  }
  await rollbackTail(c, expected);
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
const eventsThroughRollback = (options: { readonly drain: boolean }): Handler => async (c) => {
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
  c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd));
  await swapGrants(c.db, c.role, "runtime");
  if (options.drain) {
    await c.daemon(async (daemon) => {
      await c.promote(daemon, "events-promote");
      await acknowledgeEvents(c, "f6-post", ["f6-post-pending"]);
    });
  } else {
    // No daemon runs before the rollback: its start-up sweep would deliver retained events asynchronously (#1681).
    await acknowledgeEvents(c, "f6-post", ["f6-post-pending"]);
  }
  await assertEventsJoined(c, "after-cutover");
  const represented = new Set(readEventRows(c.h).filter((row) => row.data.startsWith("f6-represented")).map((row) => row.event_uuid));
  // Represented events crossed as exactly one already-applied remote disposition each; nothing re-pended or replayed them.
  const representedRows = (await inboxRows(c.db)).filter((row) => represented.has(row.event_id));
  if (representedRows.length !== represented.size || representedRows.some((row) => row.status !== "applied")) {
    throw new Error("represented events are not exactly one applied remote disposition each: " + JSON.stringify(representedRows.map((row) => row.status)));
  }
  c.mark("I3", "represented-applied-once:" + String(represented.size));
  const pgBefore = await postgresDomainDigests(c.db, c.h.cwd);
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
  const expected = await postgresDomainDigests(c.db, c.h.cwd);
  await interruptRollback(c, interruption);
  c.authority("rollback-interrupted");
  c.sealCheck("after-interruption");
  await c.step("report-rollback-interrupted");
  await c.step("rollback");
  c.authority("rolled-back");
  c.sealCheck("after-rollback");
  c.compareDomains("sqlite-after-rollback", expected, sqliteDomainDigests(projectDb(c)));
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
const setPostgres = async (c: RehearsalCase) => ({ a: await postgresDomainDigests(c.db, c.h.cwd), b: await postgresDomainDigests(c.db, secondOf(c).cwd) });

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
  await prepareSet(c);
  await c.step("set-resume-dry-run");
  await c.step("set-activate-dry-run");
  await c.step("set-activate");
  c.authority("activated");
  c.sealCheck("after-activate");
  const activated = await setPostgres(c);
  c.compareDomains("postgresql-a-after-activate", base.a, activated.a);
  c.compareDomains("postgresql-b-after-activate", base.b, activated.b);
  assertLedgerRetained(c, "after-activate");
  await swapGrants(c.db, c.role, "runtime");
  await c.step("set-report-active");
  await withProject(c, secondOf(c), () => guardedWrite(c, "s1-post-write-b"));
  const written = await setPostgres(c);
  if (written.b.conversations!.count !== base.b.conversations!.count + 1) throw new Error("the member B write did not land");
  await c.step("set-rollback-dry-run");
  await c.step("set-rollback");
  c.authority("rolled-back");
  c.sealCheck("after-rollback");
  c.compareDomains("sqlite-a-after-rollback", written.a, sqliteDomainDigests(projectDb(c)));
  c.compareDomains("sqlite-b-after-rollback", written.b, sqliteDomainDigests(projectDbOf(secondOf(c))));
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
  await swapGrants(c.db, c.role, "runtime");
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
  assertLedgerRetained(c, "after-rollback");
  await c.step("set-report-rolled-back");
  await c.step("set-rollback-repeat");
};

const setMemberDrift: Handler = async (c) => {
  const base = setBaselines(c);
  await acknowledgeEvents(c, "s4", ["s4-pending-a"]);
  await prepareSet(c);
  // Member B's destination moves after verification: its census no longer matches its report.
  const remoteB = await destinationProjectId(c.db, secondOf(c).cwd);
  await adminSql(c.db, "INSERT INTO lcm.conversations(project_id, session_id, title) VALUES ($1, 'drift-session', 'Drift')", [remoteB]);
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
  await swapGrants(c.db, c.role, "runtime");
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
  c.compareDomains("sqlite-a-after-rollback", written.a, sqliteDomainDigests(projectDb(c)));
  c.compareDomains("sqlite-b-after-rollback", written.b, sqliteDomainDigests(projectDbOf(secondOf(c))));
  assertLedgerRetained(c, "after-rollback");
  await c.step("set-report-rolled-back");
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
      c.authority("daemon-running");
      await c.step("report-daemon");
      c.mark("I1", "daemon-health:postgresql");
    });
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
    if (await expireCopyLease(c.db) !== 1) throw new Error("expected exactly one dead copy lease");
    await c.step("resume");
    c.authority("held");
    await c.step("report-copied");
    await c.step("verify");
    await c.step("verify-repeat");
    c.sealCheck("after-verify");
    await c.step("activate");
    c.authority("activated");
    c.sealCheck("after-activate");
    c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd));
    assertLedgerRetained(c, "after-activate");
    await swapGrants(c.db, c.role, "runtime");
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
    c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd));
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
    const batches = await adminSql(c.db, "SELECT count(*)::int AS n, count(DISTINCT (domain, first_ordinal))::int AS distinct_first FROM lcm.transfer_batches");
    if (batches[0]!.n !== batches[0]!.distinct_first) throw new Error("a copy batch was recorded more than once");
    c.mark("I3", "receipts:" + String(batches[0]!.n));
    await c.step("report-copied");
    await c.step("verify");
    await c.step("activate");
    c.authority("activated");
    c.sealCheck("after-activate");
    c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd));
    assertLedgerRetained(c, "after-activate");
    await swapGrants(c.db, c.role, "runtime");
    await c.step("report-active");
  },
  "F10": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    const sqliteEnv = Object.fromEntries(Object.entries(c.h.env).filter(([name]) => !name.startsWith("LCM_POSTGRES_")));
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
    c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd));
    await swapGrants(c.db, c.role, "runtime");
    await c.daemon(async (daemon) => {
      if ((daemon.health as { storageBackend?: string }).storageBackend !== "postgresql") throw new Error("the restarted daemon did not start on PostgreSQL");
      await c.step("report-active");
      c.mark("I1", "restarted-daemon-health:postgresql");
    });
    // Neither daemon wrote the SQLite project database after the cutover.
    if (sha256(readFileSync(projectDb(c))) !== sourceBefore) throw new Error("a daemon wrote the SQLite project database");
    c.mark("I2", "sqlite-project-database-unchanged");
  },
  "F5": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    await acknowledgeEvents(c, "f5-pre", ["f5-pre-1", "f5-pre-2"]);
    const plan = await c.step("plan");
    c.vars.gen = plan.envelope.generation as string;
    await c.step("apply");
    c.authority("held");
    c.sealBaseline();
    // The held gap: a hook append is either refused (no acknowledgement, nothing to lose) or retained above the sealed cutoff.
    let gap: "accepted" | "refused" = "accepted";
    try { await acknowledgeEvents(c, "f5-gap", ["f5-gap-1"]); } catch { gap = "refused"; }
    c.mark("I3", "hold-gap-append:" + gap);
    await c.step("verify");
    assertLedgerRetained(c, "after-verify");
    await c.step("activate");
    c.authority("activated");
    c.sealCheck("after-activate");
    assertLedgerRetained(c, "after-activate");
    c.compareDomains("postgresql-after-activate", baseline, await postgresDomainDigests(c.db, c.h.cwd));
    await swapGrants(c.db, c.role, "runtime");
    await c.daemon(async (daemon) => {
      await acknowledgeEvents(c, "f5-post", ["f5-post-1"]);
      // One bounded awaited drain request, twice; no sleeps and no retry loop.
      await c.promote(daemon, "events-promote");
      await c.promote(daemon, "events-promote-again");
    });
    await assertEventsJoined(c, "after-drain");
  },
  "F6": eventsThroughRollback({ drain: false }),
  "F6b": eventsThroughRollback({ drain: true }),
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
    const expected = await postgresDomainDigests(c.db, c.h.cwd);
    await interruptRollback(c, { kind: "before-complete-selection" });
    c.authority("rollback-interrupted");
    assertLedgerRetained(c, "after-interruption");
    await c.step("report-rollback-interrupted");
    await c.step("rollback");
    c.authority("rolled-back");
    assertLedgerRetained(c, "after-rollback");
    c.sealCheck("after-rollback");
    c.compareDomains("sqlite-after-rollback", expected, sqliteDomainDigests(projectDb(c)));
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
    c.mark("I4", "write-before-fence-carried");
    await c.step("report-rolled-back");
    await c.step("rollback-repeat");
  },
  "L1": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    await forward(c, baseline);
    await guardedWrite(c, "rehearsal-post-write");
    const before = await postgresDomainDigests(c.db, c.h.cwd);
    await interruptRollback(c, { kind: "before-complete-selection" });
    c.authority("rollback-interrupted");
    // Out-of-band, unguarded destination change after the selection was prepared.
    await adminSql(c.db, "UPDATE lcm.messages SET content = 'l1-out-of-band' WHERE ctid = (SELECT ctid FROM lcm.messages LIMIT 1)");
    c.injections.push({ surface: "module-seam", boundary: "unguarded destination change after the prepared selection", kind: "destination-mutation", hitCount: 1 });
    await c.step("rollback-drift");
    await c.step("rollback-drift-again");
    await c.step("abort-refused");
    c.authority("rollback-interrupted");
    c.sealCheck("after-refusals");
    const after = await postgresDomainDigests(c.db, c.h.cwd);
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
  "F1-alias": async (c) => {
    const baseline = sqliteDomainDigests(projectDb(c));
    await forward(c, baseline);
    const aliases = await adminSql(c.db, "SELECT count(*)::int AS n, count(DISTINCT project_id)::int AS projects FROM lcm.project_aliases");
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
    await adminSql(c.db, "UPDATE lcm.messages SET content = 'rehearsal-tampered' WHERE ctid = (SELECT ctid FROM lcm.messages LIMIT 1)");
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
    const remote = await destinationProjectId(c.db, c.h.cwd);
    // Installation B is bound to the shared destination project (the durable state a PostgreSQL link leaves in its project map)
    // while it selects SQLite and holds its own history.
    writeFileSync(projectMapPath(one.home), JSON.stringify({ [one.localProjectId]: { canonical: one.cwd, aliases: [], remoteProjectId: remote } }) + "\n", { mode: 0o600 });
    c.note("bind-shared-project", "module-seam", ["installation-b project map binds the shared destination project"]);
    const before = installationDigests([one, two]);
    // Installation B's operator prepares its own migration: the transfer grants are back for that run.
    await swapGrants(c.db, c.role, "transfer");
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
  // Only this row's owned role loses its permission: the selected PostgreSQL becomes unreachable for the operator.
  await swapGrants(c.db, c.role, "none");
  c.injections.push({ surface: "module-seam", boundary: "owned role permission revoked after selection", kind: "unreachable-target", hitCount: 1 });
  await c.step("report-unreachable");
  let daemonOutcome = "started";
  try {
    await c.daemon(async (daemon) => { daemonOutcome = "healthy:" + String((daemon.health as { storageBackend?: string }).storageBackend); });
  } catch (error) {
    daemonOutcome = "refused:" + (error instanceof Error ? error.message.slice(0, 40) : "unknown");
  }
  c.note("daemon-start-unreachable", "cli", [daemonOutcome]);
  if (!daemonOutcome.startsWith("refused:")) throw new Error("the daemon did not refuse an unreachable selected PostgreSQL: " + daemonOutcome);
  c.authority("activated");
  if (sha256(readFileSync(projectDb(c))) !== sourceBefore) throw new Error("a canonical write reached the SQLite project database");
  if (JSON.stringify(readdirSync(join(c.h.home, ".lcm", "projects")).sort()) !== JSON.stringify(databasesBefore)) throw new Error("a new project database appeared");
  c.mark("I5", "explicit-failure-no-sqlite-fallback:" + daemonOutcome);
  await swapGrants(c.db, c.role, "runtime");
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
    c.ledger.push(...readEventRows(c.h).map((row) => ({ eventUuid: row.event_uuid, machineSequence: row.machine_sequence, envelopeSha256: envelopeHash(row) })));
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
}

async function runScenario(spec: ScenarioSpec, index: number): Promise<void> {
  await withPostgreSqlTestDatabase("rh" + String(index), async (db) => {
    const role = await provisionRole(db);
    if (database === null) {
      const observed = await adminSql(db, "SELECT version() AS version, current_setting('server_version_num') AS number");
      database = { serverVersion: String(observed[0]!.version), serverVersionNum: String(observed[0]!.number) };
    }
    const port = await unusedPort();
    const h = createHome(spec.id, role, port);
    const c = new RehearsalCase(spec, manifest, db, role, h);
    c.daemonPort = port;
    let failure: string | undefined;
    try {
      await prepare(c);
      const handler = handlers[spec.id];
      if (handler === undefined) throw new Error("no handler for manifest row " + spec.id);
      await handler(c);
      c.mark("I5", "disclosure-scan:" + String(c.steps.length));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await c.cleanup();
      const failed = failure !== undefined || Object.values(c.invariants).some((entry) => entry.status === "fail");
      const record = c.record(failed ? "fail" : spec.knownLimits.length > 0 ? "pass-with-documented-limits" : "pass", failure);
      results.push(record);
      writeEvidence("scenarios/" + spec.id + ".json", record);
    }
  });
}

selected.forEach((spec, index) => {
  it(spec.id + ": " + spec.title, () => runScenario(spec, index), spec.timeoutMs);
});

afterAll(() => {
  const missing = selected.filter((spec) => !results.some((record) => record.id === spec.id)).map((spec) => spec.id);
  const allHomesAbsent = results.length > 0 && results.every((record) => (record.invariants as Record<string, { status: string }>).I6?.status === "pass");
  const aggregate = {
    schemaVersion: 1, manifestSha256, profile, workers: 1, selection: selected.map((spec) => spec.id), pending, missing,
    ...(database === null ? {} : { database }),
    scenarios: results, cleanup: { scenarioHomes: allHomesAbsent ? "verified-absent" : "incomplete", harnessResources: "pending-outer-audit" }, verdict: "incomplete",
  };
  writeEvidence("rehearsal.json", aggregate);
  // The serialized record must conform to the committed schema (the supported subset check), and every selected manifest row must be present.
  const schema = JSON.parse(readFileSync(join(process.cwd(), "test/postgresql/cutover-rehearsal/evidence-schema.json"), "utf8")) as Record<string, unknown>;
  const readBack = JSON.parse(JSON.stringify(aggregate)) as unknown;
  expect(validateEvidence(schema, readBack, "#/$defs/rehearsal")).toEqual([]);
  expect(selected.map((spec) => spec.id).sort()).toEqual(manifest.scenarios.filter((spec) => spec.gate === undefined && spec.profiles.includes(profile) && (only === undefined || only.includes(spec.id))).map((spec) => spec.id).sort());
  expect(missing).toEqual([]);
});
