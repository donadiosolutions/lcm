import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../src/storage/portable-record.js";
import { migrationWitnessSha256, MigrationActivationWitnessError } from "../../src/migration/activation-witness.js";
import {
  hasInterruptedEvidenceWrite,
  migrationActivationEvidenceDirectory,
  readMigrationActivationEvidence,
  recordMigrationActivationAttempt,
  recordMigrationActivationEpoch,
  recordMigrationActivationWitness,
  recoverInterruptedRollbackWitnessWrite,
  resolveRollbackAuthoritativeContext,
} from "../../src/migration/activation-evidence-store.js";
import {
  MigrationBindingConflictError,
  MigrationBindingValidationError,
} from "../../src/migration/generation-binding-store.js";
import type { BoundedFileResult } from "../../src/security-files.js";
import {
  driftCanonicalDelta,
  fixtureActivationWitness,
  fixtureAttempt,
  fixtureCensusVector,
  fixtureEpoch,
  fixtureRollbackWitness,
} from "../fixtures/migration-activation-records.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-evidence-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

const GENERATION_ID = "generation-1";
const dir = (homeDir: string, generationId = GENERATION_ID): string =>
  migrationActivationEvidenceDirectory(homeDir, generationId);

function recordAll(homeDir: string) {
  const epoch = fixtureEpoch({ generationId: GENERATION_ID });
  const attempt = fixtureAttempt({ epoch });
  const witness = fixtureActivationWitness(epoch, attempt);
  recordMigrationActivationEpoch({ homeDir, epoch });
  recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt });
  recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness });
  return { epoch, attempt, witness };
}

/** The bytes a writer produces for a record (the store's canonical wire form). */
function wire(record: unknown, generationId = GENERATION_ID): string {
  return canonicalJson({ version: 1, generationId, record }) + "\n";
}

/** Plant bytes directly, as a corrupted disk (or a hostile writer) would hold them. */
function plant(homeDir: string, name: string, content: string): string {
  mkdirSync(dir(homeDir), { recursive: true, mode: 0o700 });
  const path = join(dir(homeDir), name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

/** A witness whose evidence was mutated and whose checksum alone was recomputed. */
function forgedWitness(witness: ReturnType<typeof fixtureActivationWitness>) {
  const { checksumSha256: _discarded, ...payload } = witness;
  const forged = { ...payload, censusMatchVerdict: !witness.censusMatchVerdict };
  return { ...forged, checksumSha256: migrationWitnessSha256(forged) };
}

describe("activation evidence store: writers", () => {
  it("records the epoch, attempt and witness in order and reads them back as parsed records", () => {
    const homeDir = home();
    const { epoch, attempt, witness } = recordAll(homeDir);
    expect(readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID })).toEqual({
      state: "resolved", epochs: [epoch], attempts: [attempt], witnesses: [witness],
    });
  });

  it("reuses byte-identical records on retry without rewriting them", () => {
    const homeDir = home();
    const { epoch, attempt, witness } = recordAll(homeDir);
    const path = join(dir(homeDir), "epoch-" + epoch.epochId + ".json");
    const before = statSync(path).ino;
    recordMigrationActivationEpoch({ homeDir, epoch });
    recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt });
    recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness });
    expect(statSync(path).ino).toBe(before);
  });

  it("refuses an epoch whose id does not match its preimage, before touching disk", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    expect(() => recordMigrationActivationEpoch({
      homeDir, epoch: { ...epoch, generationId: "generation-2" },
    })).toThrow(MigrationActivationWitnessError);
    expect(existsSync(dir(homeDir, "generation-2"))).toBe(false);
  });

  it("refuses a different epoch stored under the same id as a conflict", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    recordMigrationActivationEpoch({ homeDir, epoch });
    // epochId does not cover the census vector, so this is a different record under the same key.
    const other = fixtureEpoch({ generationId: GENERATION_ID, censusVector: fixtureCensusVector("other") });
    expect(other.epochId).toBe(epoch.epochId);
    expect(() => recordMigrationActivationEpoch({ homeDir, epoch: other })).toThrow(MigrationBindingConflictError);
  });

  it("refuses an attempt before its epoch is stored, and creates nothing", () => {
    const homeDir = home();
    const attempt = fixtureAttempt({ epoch: fixtureEpoch({ generationId: GENERATION_ID }) });
    expect(() => recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt }))
      .toThrowError(expect.objectContaining({ name: "MigrationActivationEvidenceRefusalError", reason: "epoch-missing" }));
    expect(existsSync(dir(homeDir))).toBe(false);
  });

  it("refuses an attempt when only a different epoch is stored", () => {
    const homeDir = home();
    recordMigrationActivationEpoch({ homeDir, epoch: fixtureEpoch({ generationId: GENERATION_ID, seed: "one" }) });
    const attempt = fixtureAttempt({ epoch: fixtureEpoch({ generationId: GENERATION_ID, seed: "two" }) });
    expect(() => recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt }))
      .toThrowError(expect.objectContaining({ reason: "epoch-missing" }));
  });

  it("refuses a witness before its epoch, then before its attempt", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const attempt = fixtureAttempt({ epoch });
    const witness = fixtureActivationWitness(epoch, attempt);
    expect(() => recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness }))
      .toThrowError(expect.objectContaining({ reason: "epoch-missing" }));
    recordMigrationActivationEpoch({ homeDir, epoch });
    expect(() => recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness }))
      .toThrowError(expect.objectContaining({ reason: "attempt-missing" }));
  });

  it("refuses a witness whose evidence was mutated and whose checksum alone was recomputed", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const attempt = fixtureAttempt({ epoch });
    recordMigrationActivationEpoch({ homeDir, epoch });
    recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt });
    const witness = forgedWitness(fixtureActivationWitness(epoch, attempt));
    expect(() => recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness }))
      .toThrowError(expect.objectContaining({ reason: "witness-does-not-reproduce" }));
    expect(existsSync(join(dir(homeDir), "witness-" + witness.checksumSha256 + ".json"))).toBe(false);
  });

  it("refuses a rollback witness whose claimed mode its own evidence does not classify to", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const attempt = fixtureAttempt({ epoch });
    recordMigrationActivationEpoch({ homeDir, epoch });
    recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt });
    // A changed delta is post-write evidence; claiming pre-write (with a census to satisfy the parser) is forged.
    const payload = {
      version: 1 as const, kind: "rollback" as const, epochId: epoch.epochId, attemptId: attempt.attemptId,
      censusMatchVerdict: true,
      postEpochDelta: driftCanonicalDelta(attempt.canonicalDeltaBaseline, 0),
      postEpochCensus: epoch.censusVector, rollbackMode: "pre-write" as const,
    };
    const witness = { ...payload, checksumSha256: migrationWitnessSha256(payload) };
    expect(() => recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness }))
      .toThrowError(expect.objectContaining({ reason: "witness-does-not-reproduce" }));
  });

  it("records an honest rollback witness beside the activation witness", () => {
    const homeDir = home();
    const { epoch, attempt, witness } = recordAll(homeDir);
    const rollback = fixtureRollbackWitness({
      epoch, attempt, postEpochDelta: driftCanonicalDelta(attempt.canonicalDeltaBaseline, 1),
      postEpochCensus: null, rollbackMode: "post-write",
    });
    recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness: rollback });
    const stored = readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID });
    if (stored.state !== "resolved") throw new Error("expected resolved");
    expect(stored.witnesses.map((entry) => entry.checksumSha256).sort())
      .toEqual([witness.checksumSha256, rollback.checksumSha256].sort());
  });

  it("refuses to write when the stored evidence is unreadable", () => {
    const homeDir = home();
    const { epoch } = recordAll(homeDir);
    writeFileSync(join(dir(homeDir), "epoch-" + epoch.epochId + ".json"), "{corrupt", { mode: 0o600 });
    const attempt = fixtureAttempt({ epoch, seed: "second" });
    expect(() => recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt }))
      .toThrowError(expect.objectContaining({ reason: "evidence-unresolvable" }));
  });

  it("rejects invalid input before any I/O", () => {
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const attempt = fixtureAttempt({ epoch });
    expect(() => recordMigrationActivationEpoch({ homeDir: "", epoch })).toThrow(MigrationBindingValidationError);
    expect(() => recordMigrationActivationAttempt({ homeDir: home(), generationId: "../x", attempt }))
      .toThrow(MigrationBindingValidationError);
    expect(() => readMigrationActivationEvidence({ homeDir: home(), generationId: "" }))
      .toThrow(MigrationBindingValidationError);
  });

  it("recovers an interrupted durable write: a post-link scratch twin is read as-is, then completed by the writer", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const name = "epoch-" + epoch.epochId + ".json";
    const scratch = plant(homeDir, "." + name + ".0123abcd.tmp", wire(epoch));
    linkSync(scratch, join(dir(homeDir), name));
    expect(readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID })).toMatchObject({ state: "resolved" });
    expect(statSync(join(dir(homeDir), name)).nlink).toBe(2);
    recordMigrationActivationEpoch({ homeDir, epoch });
    expect(statSync(join(dir(homeDir), name)).nlink).toBe(1);
    expect(existsSync(scratch)).toBe(false);
  });

  it("A19: a lone scratch with no published file is unresolvable, and the writer's retry publishes and clears it", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const name = "epoch-" + epoch.epochId + ".json";
    const scratch = plant(homeDir, "." + name + ".0123abcd.tmp", wire(epoch));
    expect(readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID }))
      .toMatchObject({ state: "unresolvable" });

    recordMigrationActivationEpoch({ homeDir, epoch });

    expect(existsSync(scratch)).toBe(false);
    expect(readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID }))
      .toMatchObject({ state: "resolved" });
  });

  it("A19: a lone scratch identical to the published file is ignored; a differing one is not", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    recordMigrationActivationEpoch({ homeDir, epoch });
    const name = "epoch-" + epoch.epochId + ".json";
    const identical = plant(homeDir, "." + name + ".0123abcd.tmp", wire(epoch));
    expect(readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID })).toMatchObject({ state: "resolved" });
    expect(existsSync(identical)).toBe(true);
    plant(homeDir, "." + name + ".0123abce.tmp", "half written");
    expect(readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID }))
      .toMatchObject({ state: "unresolvable" });
  });
});

describe("activation evidence store: interrupted first write of the record being written (#1769)", () => {
  const read = (homeDir: string) => readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID });
  const attemptName = (attempt: { attemptId: string }): string => "attempt-" + attempt.attemptId + ".json";
  const witnessName = (witness: { checksumSha256: string }): string => "witness-" + witness.checksumSha256 + ".json";
  /** The writer's scratch name for a final: .<final>.<hex>.tmp. */
  const scratchOf = (name: string, hex = "0123abcd"): string => "." + name + "." + hex + ".tmp";
  const entries = (homeDir: string): string[] => readdirSync(dir(homeDir)).sort();

  function seeded(through: "epoch" | "attempt") {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const attempt = fixtureAttempt({ epoch });
    const witness = fixtureActivationWitness(epoch, attempt);
    recordMigrationActivationEpoch({ homeDir, epoch });
    if (through === "attempt") recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt });
    return { homeDir, epoch, attempt, witness };
  }

  it("finishes an interrupted attempt write: the retry publishes the canonical final, clears the scratch and reuses it afterwards", () => {
    const { homeDir, attempt } = seeded("epoch");
    const scratch = plant(homeDir, scratchOf(attemptName(attempt)), wire(attempt));
    // The strict reader keeps refusing the lone scratch.
    expect(read(homeDir)).toMatchObject({ state: "unresolvable" });

    recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt });

    const finalPath = join(dir(homeDir), attemptName(attempt));
    expect(readFileSync(finalPath, "utf8")).toBe(wire(attempt));
    expect(existsSync(scratch)).toBe(false);
    expect(read(homeDir)).toMatchObject({ state: "resolved", attempts: [attempt] });
    const inode = statSync(finalPath).ino;
    recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt });
    expect(statSync(finalPath).ino).toBe(inode);
  });

  it("finishes an interrupted witness write: the retry publishes the canonical final, clears the scratch and reuses it afterwards", () => {
    const { homeDir, witness } = seeded("attempt");
    const scratch = plant(homeDir, scratchOf(witnessName(witness)), wire(witness));
    expect(read(homeDir)).toMatchObject({ state: "unresolvable" });

    recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness });

    const finalPath = join(dir(homeDir), witnessName(witness));
    expect(readFileSync(finalPath, "utf8")).toBe(wire(witness));
    expect(existsSync(scratch)).toBe(false);
    expect(read(homeDir)).toMatchObject({ state: "resolved", witnesses: [witness] });
    const inode = statSync(finalPath).ino;
    recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness });
    expect(statSync(finalPath).ino).toBe(inode);
  });

  type Orphan = Readonly<{ label: string; through: "epoch" | "attempt"; write: (s: ReturnType<typeof seeded>) => void; finalName: (s: ReturnType<typeof seeded>) => string; wire: (s: ReturnType<typeof seeded>) => string }>;
  const orphans: readonly Orphan[] = [
    {
      label: "attempt", through: "epoch",
      write: ({ homeDir, attempt }) => recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt }),
      finalName: ({ attempt }) => attemptName(attempt), wire: ({ attempt }) => wire(attempt),
    },
    {
      label: "witness", through: "attempt",
      write: ({ homeDir, witness }) => recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness }),
      finalName: ({ witness }) => witnessName(witness), wire: ({ witness }) => wire(witness),
    },
  ];

  describe.each(orphans)("an orphan $label scratch that cannot be trusted", (orphan) => {
    const refusedUntouched = (state: ReturnType<typeof seeded>, scratchName: string, content: string) => {
      expect(() => orphan.write(state)).toThrowError(
        expect.objectContaining({ name: "MigrationActivationEvidenceRefusalError", reason: "evidence-unresolvable" }),
      );
      expect(existsSync(join(dir(state.homeDir), orphan.finalName(state)))).toBe(false);
      expect(readFileSync(join(dir(state.homeDir), scratchName), "utf8")).toBe(content);
    };

    it("is refused when its bytes differ from the record being written, leaving the scratch", () => {
      const state = seeded(orphan.through);
      const differing = orphan.wire(state).replace(/\n$/u, " \n");
      plant(state.homeDir, scratchOf(orphan.finalName(state)), differing);
      refusedUntouched(state, scratchOf(orphan.finalName(state)), differing);
    });

    it("is refused when its mode is not the writer's", () => {
      const state = seeded(orphan.through);
      const path = plant(state.homeDir, scratchOf(orphan.finalName(state)), orphan.wire(state));
      chmodSync(path, 0o644);
      refusedUntouched(state, scratchOf(orphan.finalName(state)), orphan.wire(state));
    });

    it("is refused when it has more than one link", () => {
      const state = seeded(orphan.through);
      const path = plant(state.homeDir, scratchOf(orphan.finalName(state)), orphan.wire(state));
      linkSync(path, join(dir(state.homeDir), scratchOf(orphan.finalName(state), "0123abce")));
      refusedUntouched(state, scratchOf(orphan.finalName(state)), orphan.wire(state));
    });

    it("is refused when its name is not a writer scratch of a final record", () => {
      const state = seeded(orphan.through);
      plant(state.homeDir, ".notes.txt.0123abcd.tmp", orphan.wire(state));
      refusedUntouched(state, ".notes.txt.0123abcd.tmp", orphan.wire(state));
    });
  });

  it("refuses a lone scratch of another record than the one being written", () => {
    const { homeDir, attempt, witness } = seeded("epoch");
    plant(homeDir, scratchOf(witnessName(witness)), wire(witness));
    expect(() => recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt }))
      .toThrowError(expect.objectContaining({ reason: "evidence-unresolvable" }));
    expect(existsSync(join(dir(homeDir), attemptName(attempt)))).toBe(false);
    expect(entries(homeDir)).toContain(scratchOf(witnessName(witness)));
  });

  it("keeps the ordering checks for an orphan: an attempt scratch without its epoch is epoch-missing", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const attempt = fixtureAttempt({ epoch });
    plant(homeDir, scratchOf(attemptName(attempt)), wire(attempt));
    expect(() => recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt }))
      .toThrowError(expect.objectContaining({ reason: "epoch-missing" }));
    expect(existsSync(join(dir(homeDir), attemptName(attempt)))).toBe(false);
    expect(existsSync(join(dir(homeDir), scratchOf(attemptName(attempt))))).toBe(true);
  });

  it("keeps the ordering checks for an orphan: a witness scratch without its epoch is epoch-missing, without its attempt attempt-missing", () => {
    const { homeDir, witness } = seeded("epoch");
    plant(homeDir, scratchOf(witnessName(witness)), wire(witness));
    expect(() => recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness }))
      .toThrowError(expect.objectContaining({ reason: "attempt-missing" }));
    const bare = home();
    plant(bare, scratchOf(witnessName(witness)), wire(witness));
    expect(() => recordMigrationActivationWitness({ homeDir: bare, generationId: GENERATION_ID, witness }))
      .toThrowError(expect.objectContaining({ reason: "epoch-missing" }));
    expect(existsSync(join(dir(bare), witnessName(witness)))).toBe(false);
  });

  it("keeps the reproduction check for an orphan witness scratch that its stored epoch and attempt do not mint", () => {
    const { homeDir, witness } = seeded("attempt");
    const forged = forgedWitness(witness);
    plant(homeDir, scratchOf(witnessName(forged)), wire(forged));
    expect(() => recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness: forged }))
      .toThrowError(expect.objectContaining({ reason: "witness-does-not-reproduce" }));
    expect(existsSync(join(dir(homeDir), witnessName(forged)))).toBe(false);
    expect(existsSync(join(dir(homeDir), scratchOf(witnessName(forged))))).toBe(true);
  });

  describe("nextWitness (re-entry of the chain after an interrupted witness write)", () => {
    const chain = (state: ReturnType<typeof seeded>, nextWitness?: typeof state.witness) =>
      recordMigrationActivationAttempt({
        homeDir: state.homeDir, generationId: GENERATION_ID, attempt: state.attempt,
        ...(nextWitness === undefined ? {} : { nextWitness }),
      });

    it("lets the attempt writer re-enter beside the canonical witness scratch; the witness writer then finishes it", () => {
      const state = seeded("attempt");
      const scratch = plant(state.homeDir, scratchOf(witnessName(state.witness)), wire(state.witness));
      const finalPath = join(dir(state.homeDir), attemptName(state.attempt));
      const inode = statSync(finalPath).ino;

      chain(state, state.witness);

      expect(statSync(finalPath).ino).toBe(inode);
      expect(existsSync(scratch)).toBe(true);
      expect(existsSync(join(dir(state.homeDir), witnessName(state.witness)))).toBe(false);
      recordMigrationActivationWitness({ homeDir: state.homeDir, generationId: GENERATION_ID, witness: state.witness });
      expect(existsSync(scratch)).toBe(false);
      expect(read(state.homeDir)).toMatchObject({ state: "resolved", attempts: [state.attempt], witnesses: [state.witness] });
    });

    it("without nextWitness a direct attempt write still refuses the unrelated witness scratch", () => {
      const state = seeded("attempt");
      plant(state.homeDir, scratchOf(witnessName(state.witness)), wire(state.witness));
      expect(() => chain(state)).toThrowError(expect.objectContaining({ reason: "evidence-unresolvable" }));
    });

    it("also finishes an interrupted attempt write when it is given", () => {
      const state = seeded("epoch");
      const scratch = plant(state.homeDir, scratchOf(attemptName(state.attempt)), wire(state.attempt));
      chain(state, state.witness);
      expect(readFileSync(join(dir(state.homeDir), attemptName(state.attempt)), "utf8")).toBe(wire(state.attempt));
      expect(existsSync(scratch)).toBe(false);
    });

    it("refuses a witness scratch whose bytes differ from the next witness, writing nothing", () => {
      const state = seeded("epoch");
      const differing = wire(state.witness).replace(/\n$/u, " \n");
      plant(state.homeDir, scratchOf(witnessName(state.witness)), differing);
      expect(() => chain(state, state.witness)).toThrowError(expect.objectContaining({ reason: "evidence-unresolvable" }));
      expect(existsSync(join(dir(state.homeDir), attemptName(state.attempt)))).toBe(false);
      expect(readFileSync(join(dir(state.homeDir), scratchOf(witnessName(state.witness))), "utf8")).toBe(differing);
    });

    it("refuses a next witness that names another attempt or another epoch before any read or write", () => {
      const state = seeded("epoch");
      const otherAttempt = fixtureAttempt({ epoch: state.epoch, seed: "other" });
      const foreignAttempt = fixtureActivationWitness(state.epoch, otherAttempt);
      expect(() => chain(state, foreignAttempt)).toThrowError(MigrationActivationWitnessError);
      const { checksumSha256: _discarded, ...payload } = state.witness;
      const reEpoched = { ...payload, epochId: "e".repeat(64) };
      const foreignEpoch = { ...reEpoched, checksumSha256: migrationWitnessSha256(reEpoched) };
      expect(() => chain(state, foreignEpoch)).toThrowError(
        expect.objectContaining({ name: "MigrationActivationWitnessError", reason: "unexpected-state" }),
      );
      expect(existsSync(join(dir(state.homeDir), attemptName(state.attempt)))).toBe(false);
    });
  });
});

describe("activation evidence store: reader", () => {
  const read = (homeDir: string) => readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID });
  const unresolvable = (homeDir: string): string => {
    const result = read(homeDir);
    if (result.state !== "unresolvable") throw new Error("expected unresolvable, got " + result.state);
    return result.reason;
  };

  it("is authoritatively absent for a missing store, a missing generation, and an empty generation", () => {
    const homeDir = home();
    expect(read(homeDir)).toEqual({ state: "authoritatively-absent" });
    expect(existsSync(dir(homeDir))).toBe(false);
    mkdirSync(dir(homeDir), { recursive: true, mode: 0o700 });
    expect(read(homeDir)).toEqual({ state: "authoritatively-absent" });
  });

  it("is unresolvable for an unreadable directory, never absent", () => {
    const homeDir = home();
    recordAll(homeDir);
    chmodSync(dir(homeDir), 0o000);
    try {
      expect(unresolvable(homeDir)).toContain("cannot be read");
    } finally {
      chmodSync(dir(homeDir), 0o700);
    }
  });

  it("is unresolvable when a bounded read fails", () => {
    const homeDir = home();
    recordAll(homeDir);
    const readWithStat = (): BoundedFileResult => { throw new Error("injected"); };
    expect(readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID }, { readWithStat }))
      .toMatchObject({ state: "unresolvable" });
  });

  it("is unresolvable for an unknown entry", () => {
    const homeDir = home();
    recordAll(homeDir);
    plant(homeDir, "notes.txt", "x");
    expect(unresolvable(homeDir)).toContain("unknown entry");
  });

  it("lists records ascending by id", () => {
    const homeDir = home();
    const epochs = ["one", "two", "three"].map((seed) => fixtureEpoch({ generationId: GENERATION_ID, seed }));
    for (const epoch of epochs) recordMigrationActivationEpoch({ homeDir, epoch });
    const result = read(homeDir);
    if (result.state !== "resolved") throw new Error("expected resolved");
    expect(result.epochs.map((epoch) => epoch.epochId)).toEqual(epochs.map((epoch) => epoch.epochId).sort());
  });

  it("is unresolvable when an attempt's epoch is not stored", () => {
    const homeDir = home();
    const { epoch } = recordAll(homeDir);
    rmSync(join(dir(homeDir), "epoch-" + epoch.epochId + ".json"));
    expect(unresolvable(homeDir)).toContain("attempt-");
  });

  it("is unresolvable when a witness's attempt is not stored", () => {
    const homeDir = home();
    const { attempt } = recordAll(homeDir);
    rmSync(join(dir(homeDir), "attempt-" + attempt.attemptId + ".json"));
    expect(unresolvable(homeDir)).toContain("witness-");
    expect(unresolvable(homeDir)).toContain("witness names an epoch or attempt that is not stored");
  });

  it("is unresolvable for a planted witness that its stored epoch and attempt do not mint", () => {
    const homeDir = home();
    const { witness } = recordAll(homeDir);
    const forged = forgedWitness(witness);
    plant(homeDir, "witness-" + forged.checksumSha256 + ".json", wire(forged));
    expect(unresolvable(homeDir)).toContain("not what its stored epoch and attempt mint");
  });

  it("is unresolvable for a planted witness whose own checksum is wrong", () => {
    const homeDir = home();
    const { witness } = recordAll(homeDir);
    const bad = { ...witness, checksumSha256: "0".repeat(64) };
    plant(homeDir, "witness-" + bad.checksumSha256 + ".json", wire(bad));
    expect(unresolvable(homeDir)).toContain("witness-" + bad.checksumSha256);
  });

  const epoch = fixtureEpoch({ generationId: GENERATION_ID });
  const epochName = "epoch-" + epoch.epochId + ".json";
  const corruptions: ReadonlyArray<readonly [string, string, string]> = [
    ["garbage bytes", epochName, "{not json"],
    ["a non-object envelope", epochName, "[]\n"],
    ["an envelope with an unknown key", epochName, canonicalJson({ version: 1, generationId: GENERATION_ID, record: epoch, extra: 1 }) + "\n"],
    ["an unrecognised wire version", epochName, canonicalJson({ version: 2, generationId: GENERATION_ID, record: epoch }) + "\n"],
    ["a different generationId in the envelope", epochName, wire(epoch, "generation-2")],
    ["an epoch of another generation", epochName, wire(fixtureEpoch({ generationId: "generation-2" }))],
    ["an epoch whose id was tampered with", epochName, wire({ ...epoch, epochId: "1".repeat(64) })],
    ["an epoch stored under another epoch's key", "epoch-" + "2".repeat(64) + ".json", wire(epoch)],
    ["bytes that are not the writer's canonical form", epochName, JSON.stringify({ version: 1, generationId: GENERATION_ID, record: epoch }, null, 1) + "\n"],
  ];

  it.each(corruptions)("is unresolvable, never absent, for %s", (_label, name, content) => {
    const homeDir = home();
    plant(homeDir, name, content);
    expect(unresolvable(homeDir)).toContain(name);
  });
});

describe("resolveRollbackAuthoritativeContext", () => {
  const resolve = (homeDir: string, extra: Record<string, string>) =>
    resolveRollbackAuthoritativeContext({ homeDir, generationId: GENERATION_ID, epochId: "", attemptId: "", ...extra });

  it("returns the full epoch and attempt records, with the named witness when asked", async () => {
    const homeDir = home();
    const { epoch, attempt, witness } = recordAll(homeDir);
    const names = { epochId: epoch.epochId, attemptId: attempt.attemptId };
    expect(await resolve(homeDir, names)).toEqual({ epoch, attempt, witness: null });
    expect(await resolve(homeDir, { ...names, witnessChecksumSha256: witness.checksumSha256 }))
      .toEqual({ epoch, attempt, witness });
  });

  it("returns null for an absent store", async () => {
    expect(await resolve(home(), { epochId: "a".repeat(64), attemptId: "b".repeat(64) })).toBeNull();
  });

  it("returns null for a resolved store that lacks the pair", async () => {
    const homeDir = home();
    const { epoch, attempt } = recordAll(homeDir);
    expect(await resolve(homeDir, { epochId: "a".repeat(64), attemptId: attempt.attemptId })).toBeNull();
    expect(await resolve(homeDir, { epochId: epoch.epochId, attemptId: "b".repeat(64) })).toBeNull();
  });

  it("returns null for an attempt that belongs to a different epoch than the one named", async () => {
    const homeDir = home();
    const { attempt } = recordAll(homeDir);
    const otherEpoch = fixtureEpoch({ generationId: GENERATION_ID, seed: "other" });
    recordMigrationActivationEpoch({ homeDir, epoch: otherEpoch });
    expect(await resolve(homeDir, { epochId: otherEpoch.epochId, attemptId: attempt.attemptId })).toBeNull();
  });

  it("returns null when the named witness is missing or belongs to another attempt", async () => {
    const homeDir = home();
    const { epoch, witness } = recordAll(homeDir);
    const second = fixtureAttempt({ epoch, seed: "second" });
    recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt: second });
    const names = { epochId: epoch.epochId, attemptId: second.attemptId };
    expect(await resolve(homeDir, { ...names, witnessChecksumSha256: "c".repeat(64) })).toBeNull();
    // witness belongs to the first attempt
    expect(await resolve(homeDir, { ...names, witnessChecksumSha256: witness.checksumSha256 })).toBeNull();
  });

  it("returns null when the named witness names another epoch", async () => {
    const homeDir = home();
    const { epoch, attempt } = recordAll(homeDir);
    const otherEpoch = fixtureEpoch({ generationId: GENERATION_ID, seed: "other" });
    const otherAttempt = fixtureAttempt({ epoch: otherEpoch });
    const otherWitness = fixtureActivationWitness(otherEpoch, otherAttempt);
    recordMigrationActivationEpoch({ homeDir, epoch: otherEpoch });
    recordMigrationActivationAttempt({ homeDir, generationId: GENERATION_ID, attempt: otherAttempt });
    recordMigrationActivationWitness({ homeDir, generationId: GENERATION_ID, witness: otherWitness });
    expect(await resolve(homeDir, {
      epochId: epoch.epochId, attemptId: attempt.attemptId, witnessChecksumSha256: otherWitness.checksumSha256,
    })).toBeNull();
  });

  it("throws a refusal, never null, for an unresolvable store", async () => {
    const homeDir = home();
    const { epoch, attempt } = recordAll(homeDir);
    plant(homeDir, "notes.txt", "x");
    await expect(resolve(homeDir, { epochId: epoch.epochId, attemptId: attempt.attemptId }))
      .rejects.toMatchObject({ name: "MigrationActivationEvidenceRefusalError", reason: "evidence-unresolvable" });
  });
});

describe("recoverInterruptedRollbackWitnessWrite (#1808)", () => {
  const read = (homeDir: string) => readMigrationActivationEvidence({ homeDir, generationId: GENERATION_ID });
  const witnessName = (witness: { checksumSha256: string }): string => "witness-" + witness.checksumSha256 + ".json";
  const scratchOf = (name: string, hex = "0123abcd"): string => "." + name + "." + hex + ".tmp";
  const entries = (homeDir: string): string[] => readdirSync(dir(homeDir)).sort();

  function seeded() {
    const homeDir = home();
    const { epoch, attempt, witness } = recordAll(homeDir);
    const rollbackOf = (index: number) => fixtureRollbackWitness({
      epoch, attempt, postEpochDelta: driftCanonicalDelta(attempt.canonicalDeltaBaseline, index),
      postEpochCensus: null, rollbackMode: "post-write",
    });
    const input = {
      homeDir, generationId: GENERATION_ID, epochId: epoch.epochId, attemptId: attempt.attemptId,
      activationWitnessChecksumSha256: witness.checksumSha256,
    };
    return { homeDir, epoch, attempt, witness, rollbackOf, rollback: rollbackOf(1), input };
  }
  type State = ReturnType<typeof seeded>;

  /** The refusal contract: nothing written, every entry as it was, the strict reader as unresolvable as before. */
  function expectNone(state: State, run: () => string = () => recoverInterruptedRollbackWitnessWrite(state.input)): void {
    const before = entries(state.homeDir);
    const contents = before.map((name) => readFileSync(join(dir(state.homeDir), name), "utf8"));
    expect(run()).toBe("none");
    expect(entries(state.homeDir)).toEqual(before);
    expect(before.map((name) => readFileSync(join(dir(state.homeDir), name), "utf8"))).toEqual(contents);
    expect(read(state.homeDir)).toMatchObject({ state: "unresolvable" });
  }

  it("publishes the canonical rollback witness scratch of the activation, clears the scratch and then answers none", () => {
    const state = seeded();
    const scratch = plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    expect(read(state.homeDir)).toMatchObject({ state: "unresolvable" });

    expect(recoverInterruptedRollbackWitnessWrite(state.input)).toBe("recovered");

    expect(readFileSync(join(dir(state.homeDir), witnessName(state.rollback)), "utf8")).toBe(wire(state.rollback));
    expect(existsSync(scratch)).toBe(false);
    const stored = read(state.homeDir);
    if (stored.state !== "resolved") throw new Error("expected resolved");
    expect(stored.witnesses.map((entry) => entry.checksumSha256).sort())
      .toEqual([state.witness.checksumSha256, state.rollback.checksumSha256].sort());
    expect(recoverInterruptedRollbackWitnessWrite(state.input)).toBe("none");
  });

  it("publishes two distinct rollback witness scratches of the activation", () => {
    const state = seeded();
    const other = state.rollbackOf(2);
    plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    plant(state.homeDir, scratchOf(witnessName(other)), wire(other));

    expect(recoverInterruptedRollbackWitnessWrite(state.input)).toBe("recovered");

    expect(entries(state.homeDir)).toEqual([
      "attempt-" + state.attempt.attemptId + ".json", "epoch-" + state.epoch.epochId + ".json",
      witnessName(state.witness), witnessName(state.rollback), witnessName(other),
    ].sort());
    expect(read(state.homeDir)).toMatchObject({ state: "resolved" });
  });

  it("publishes a final once for duplicate scratches and clears them all", () => {
    const state = seeded();
    plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    plant(state.homeDir, scratchOf(witnessName(state.rollback), "0123abce"), wire(state.rollback));

    expect(recoverInterruptedRollbackWitnessWrite(state.input)).toBe("recovered");

    expect(entries(state.homeDir)).not.toContainEqual(expect.stringMatching(/\.tmp$/u));
    expect(read(state.homeDir)).toMatchObject({ state: "resolved" });
  });

  it("answers none, creating nothing, when there is no scratch, no store or no generation directory", () => {
    const state = seeded();
    expect(recoverInterruptedRollbackWitnessWrite(state.input)).toBe("none");
    expect(read(state.homeDir)).toMatchObject({ state: "resolved" });
    const bare = home();
    expect(recoverInterruptedRollbackWitnessWrite({ ...state.input, homeDir: bare })).toBe("none");
    expect(existsSync(dir(bare))).toBe(false);
  });

  it("does not list a scratch whose final is published", () => {
    const state = seeded();
    plant(state.homeDir, scratchOf(witnessName(state.witness)), wire(state.witness));
    expect(recoverInterruptedRollbackWitnessWrite(state.input)).toBe("none");
    expect(hasInterruptedEvidenceWrite(state.input)).toBe(false);
    expect(read(state.homeDir)).toMatchObject({ state: "resolved" });
  });

  it("refuses an activation witness scratch, which the activation chain owns", () => {
    const state = seeded();
    const second = fixtureAttempt({ epoch: state.epoch, seed: "attempt-2" });
    recordMigrationActivationAttempt({ homeDir: state.homeDir, generationId: GENERATION_ID, attempt: second });
    const activation = fixtureActivationWitness(state.epoch, second);
    plant(state.homeDir, scratchOf(witnessName(activation)), wire(activation));
    expectNone(state);
  });

  it("refuses a rollback witness scratch of another attempt or another epoch", () => {
    const state = seeded();
    const second = fixtureAttempt({ epoch: state.epoch, seed: "attempt-2" });
    recordMigrationActivationAttempt({ homeDir: state.homeDir, generationId: GENERATION_ID, attempt: second });
    const otherAttempt = fixtureRollbackWitness({
      epoch: state.epoch, attempt: second, postEpochDelta: driftCanonicalDelta(second.canonicalDeltaBaseline, 1),
      postEpochCensus: null, rollbackMode: "post-write",
    });
    plant(state.homeDir, scratchOf(witnessName(otherAttempt)), wire(otherAttempt));
    expectNone(state);

    const other = seeded();
    const epoch2 = fixtureEpoch({ generationId: GENERATION_ID, seed: "epoch-2" });
    const attempt2 = fixtureAttempt({ epoch: epoch2, seed: "attempt-3" });
    recordMigrationActivationEpoch({ homeDir: other.homeDir, epoch: epoch2 });
    recordMigrationActivationAttempt({ homeDir: other.homeDir, generationId: GENERATION_ID, attempt: attempt2 });
    const otherEpoch = fixtureRollbackWitness({
      epoch: epoch2, attempt: attempt2, postEpochDelta: driftCanonicalDelta(attempt2.canonicalDeltaBaseline, 1),
      postEpochCensus: null, rollbackMode: "post-write",
    });
    plant(other.homeDir, scratchOf(witnessName(otherEpoch)), wire(otherEpoch));
    expectNone(other);
  });

  it("refuses bytes that are not canonical, not JSON, or a witness that its stored epoch and attempt do not mint", () => {
    const noncanonical = seeded();
    plant(noncanonical.homeDir, scratchOf(witnessName(noncanonical.rollback)), wire(noncanonical.rollback).replace(/\n$/u, " \n"));
    expectNone(noncanonical);

    const garbage = seeded();
    plant(garbage.homeDir, scratchOf(witnessName(garbage.rollback)), "not json");
    expectNone(garbage);

    const forged = seeded();
    const mutated = forgedWitness(forged.rollback);
    plant(forged.homeDir, scratchOf(witnessName(mutated)), wire(mutated));
    expectNone(forged);
  });

  it("refuses a scratch of an attempt record, which this recovery does not own", () => {
    const state = seeded();
    const second = fixtureAttempt({ epoch: state.epoch, seed: "attempt-2" });
    plant(state.homeDir, scratchOf("attempt-" + second.attemptId + ".json"), wire(second));
    expectNone(state);
  });

  it("refuses all of them when one scratch is valid and another is not, leaving both", () => {
    const state = seeded();
    const second = fixtureAttempt({ epoch: state.epoch, seed: "attempt-2" });
    recordMigrationActivationAttempt({ homeDir: state.homeDir, generationId: GENERATION_ID, attempt: second });
    plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    const activation = fixtureActivationWitness(state.epoch, second);
    plant(state.homeDir, scratchOf(witnessName(activation)), wire(activation));
    expectNone(state);
  });

  it("refuses a valid scratch beside an entry the listing does not show, publishing nothing", () => {
    const state = seeded();
    plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    const loose = plant(state.homeDir, scratchOf(witnessName(state.rollbackOf(2))), wire(state.rollbackOf(2)));
    chmodSync(loose, 0o644);
    expectNone(state);
    rmSync(loose);
    plant(state.homeDir, "unknown-entry", "x");
    expectNone(state);
  });

  it("refuses scratches that are not private single-link files", () => {
    const state = seeded();
    const path = plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    chmodSync(path, 0o644);
    expectNone(state);

    const linked = seeded();
    const linkedPath = plant(linked.homeDir, scratchOf(witnessName(linked.rollback)), wire(linked.rollback));
    linkSync(linkedPath, join(dir(linked.homeDir), scratchOf(witnessName(linked.rollback), "0123abce")));
    expectNone(linked);
  });

  it("refuses when the stored activation witness is missing, is not an activation witness, or names another pair", () => {
    const missing = seeded();
    plant(missing.homeDir, scratchOf(witnessName(missing.rollback)), wire(missing.rollback));
    expectNone(missing, () => recoverInterruptedRollbackWitnessWrite({ ...missing.input, activationWitnessChecksumSha256: "f".repeat(64) }));

    const rollbackNamed = seeded();
    const published = rollbackNamed.rollbackOf(2);
    recordMigrationActivationWitness({ homeDir: rollbackNamed.homeDir, generationId: GENERATION_ID, witness: published });
    plant(rollbackNamed.homeDir, scratchOf(witnessName(rollbackNamed.rollback)), wire(rollbackNamed.rollback));
    expectNone(rollbackNamed, () => recoverInterruptedRollbackWitnessWrite({
      ...rollbackNamed.input, activationWitnessChecksumSha256: published.checksumSha256,
    }));

    const otherPair = seeded();
    const second = fixtureAttempt({ epoch: otherPair.epoch, seed: "attempt-2" });
    recordMigrationActivationAttempt({ homeDir: otherPair.homeDir, generationId: GENERATION_ID, attempt: second });
    const secondActivation = fixtureActivationWitness(otherPair.epoch, second);
    recordMigrationActivationWitness({ homeDir: otherPair.homeDir, generationId: GENERATION_ID, witness: secondActivation });
    plant(otherPair.homeDir, scratchOf(witnessName(otherPair.rollback)), wire(otherPair.rollback));
    expectNone(otherPair, () => recoverInterruptedRollbackWitnessWrite({
      ...otherPair.input, activationWitnessChecksumSha256: secondActivation.checksumSha256,
    }));
  });

  it("refuses when the named epoch or attempt is not stored", () => {
    const state = seeded();
    plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    expectNone(state, () => recoverInterruptedRollbackWitnessWrite({ ...state.input, epochId: "f".repeat(64) }));
    expectNone(state, () => recoverInterruptedRollbackWitnessWrite({ ...state.input, attemptId: "f".repeat(64) }));
  });

  it("refuses when the store holds no epoch, attempt or witness at all", () => {
    const homeDir = home();
    const epoch = fixtureEpoch({ generationId: GENERATION_ID });
    const attempt = fixtureAttempt({ epoch });
    const rollback = fixtureRollbackWitness({
      epoch, attempt, postEpochDelta: driftCanonicalDelta(attempt.canonicalDeltaBaseline, 1), postEpochCensus: null, rollbackMode: "post-write",
    });
    plant(homeDir, scratchOf(witnessName(rollback)), wire(rollback));
    expect(recoverInterruptedRollbackWitnessWrite({
      homeDir, generationId: GENERATION_ID, epochId: epoch.epochId, attemptId: attempt.attemptId, activationWitnessChecksumSha256: "a".repeat(64),
    })).toBe("none");
    expect(entries(homeDir)).toEqual([scratchOf(witnessName(rollback))]);
  });

  it("propagates a writer failure after the proof, leaving the scratch", () => {
    const state = seeded();
    plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    expect(() => recoverInterruptedRollbackWitnessWrite(state.input, {
      writeDurable: () => { throw new Error("disk full"); },
    })).toThrow("disk full");
    expect(existsSync(join(dir(state.homeDir), scratchOf(witnessName(state.rollback))))).toBe(true);
    expect(existsSync(join(dir(state.homeDir), witnessName(state.rollback)))).toBe(false);
  });

  it("hasInterruptedEvidenceWrite reports a lone scratch and nothing else", () => {
    const state = seeded();
    expect(hasInterruptedEvidenceWrite(state.input)).toBe(false);
    plant(state.homeDir, scratchOf(witnessName(state.rollback)), wire(state.rollback));
    expect(hasInterruptedEvidenceWrite(state.input)).toBe(true);
    expect(hasInterruptedEvidenceWrite({ homeDir: home(), generationId: GENERATION_ID })).toBe(false);
  });
});
