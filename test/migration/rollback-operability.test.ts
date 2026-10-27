/**
 * Boundary C's failure attribution (rollback.ts readBackendPublicationOperabilityFact):
 * every way the live-journal read can fail is "unresolvable" with the cause
 * attached, never "authoritatively-absent". The storage primitives are
 * wrapped so each failure can be injected; everything else is the real module.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  journal: undefined as undefined | (() => unknown),
  capture: undefined as undefined | (() => unknown),
  lock: undefined as undefined | (() => unknown),
}));

vi.mock("../../src/storage/backend-publication.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/backend-publication.js")>();
  return {
    ...actual,
    readBackendPublicationJournal: (...args: Parameters<typeof actual.readBackendPublicationJournal>) =>
      hooks.journal === undefined ? actual.readBackendPublicationJournal(...args) : hooks.journal(),
    captureBackendPublicationState: (...args: Parameters<typeof actual.captureBackendPublicationState>) =>
      hooks.capture === undefined ? actual.captureBackendPublicationState(...args) : hooks.capture(),
    withBackendPublicationConsumerLockAsync: (...args: Parameters<typeof actual.withBackendPublicationConsumerLockAsync>) =>
      hooks.lock === undefined ? actual.withBackendPublicationConsumerLockAsync(...args) : hooks.lock(),
  };
});

const { readBackendPublicationOperabilityFact } = await import("../../src/migration/rollback.js");
const { BackendPublicationJournalError } = await import("../../src/storage/backend-publication.js");

const dirs: string[] = [];
afterEach(() => {
  hooks.journal = undefined;
  hooks.capture = undefined;
  hooks.lock = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-operability-"));
  mkdirSync(join(dir, ".lcm"), { mode: 0o700 });
  dirs.push(dir);
  return dir;
}

const completedPostgresqlJournal = { phase: "completed", targetBackend: "postgresql", checksumSha256: "c".repeat(64) };

describe("readBackendPublicationOperabilityFact failure attribution", () => {
  it("attributes a typed journal failure with its reason", async () => {
    hooks.journal = () => { throw new BackendPublicationJournalError("malformed-journal", "journal is torn"); };
    expect(await readBackendPublicationOperabilityFact({ homeDir: tempHome() }))
      .toEqual({ state: "unresolvable", reason: "malformed-journal: journal is torn" });
  });

  it("attributes a plain Error failure with its message", async () => {
    hooks.journal = () => { throw new Error("disk read failed"); };
    expect(await readBackendPublicationOperabilityFact({ homeDir: tempHome() }))
      .toEqual({ state: "unresolvable", reason: "disk read failed" });
  });

  it("attributes a thrown non-Error value by its string form", async () => {
    hooks.journal = () => { throw "not an error object"; };
    expect(await readBackendPublicationOperabilityFact({ homeDir: tempHome() }))
      .toEqual({ state: "unresolvable", reason: "not an error object" });
  });

  it("is unresolvable, not present, when the publication state cannot be captured", async () => {
    hooks.journal = () => completedPostgresqlJournal;
    hooks.capture = () => { throw new Error("config is unsafe"); };
    expect(await readBackendPublicationOperabilityFact({ homeDir: tempHome() }))
      .toEqual({ state: "unresolvable", reason: "config is unsafe" });
  });

  it("is unresolvable when the consumer lock itself cannot be taken", async () => {
    hooks.lock = () => { throw new Error("lock is held elsewhere"); };
    expect(await readBackendPublicationOperabilityFact({ homeDir: tempHome() }))
      .toEqual({ state: "unresolvable", reason: "lock is held elsewhere" });
  });

  it("is present when the journal is completed for postgresql and its state can be captured (control)", async () => {
    hooks.journal = () => completedPostgresqlJournal;
    hooks.capture = () => ({ config: "x", projectMap: "y" });
    expect(await readBackendPublicationOperabilityFact({ homeDir: tempHome() })).toMatchObject({ state: "present" });
  });
});
