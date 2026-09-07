import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortableRecord, type PortableOrderScalar } from "../../src/storage/portable-record.js";
import { PortableTransferError } from "../../src/storage/portable-transfer.js";
import { createPortableIndex, encodePortableIndexOrder, type PortableIndex } from "../../src/storage/portable-index.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const roots: string[] = [];
const indexes: PortableIndex[] = [];
function open(options: Parameters<typeof createPortableIndex>[0] = {}) {
  const scratchParent = mkdtempSync(join(tmpdir(), "lcm-index-test-"));
  roots.push(scratchParent);
  const index = createPortableIndex({ scratchParent, ...options });
  indexes.push(index);
  return { index, scratchParent };
}
function machine(identityKey: string) {
  return createPortableRecord({ domain: "machines", ordinal: 0, value: { identityKey, machineId: null }, context: null });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const index of indexes.splice(0)) index.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable source metadata index", () => {
  it("sorts more than 500 rows, assigns ordinals and retains parent identity lookups", () => {
    const { index } = open();
    for (let i = 600; i >= 0; i--) index.add(`physical-${i}`, machine(`machine-${String(i).padStart(3, "0")}`));
    index.finalizeDomain("machines");
    const page = index.entries("machines", { afterOrdinal: -1, limit: 500, maxBytes: 1024 * 1024 });
    expect(page).toHaveLength(500);
    expect(page[0].locator).toBe("physical-0");
    expect(page[499].ordinal).toBe(499);
    expect(index.entries("machines", { afterOrdinal: 499, limit: 500, maxBytes: 1024 * 1024 })).toHaveLength(101);
    expect(index.lookupIdentity("machines", machine("machine-600").identitySha256)?.locator).toBe("physical-600");
    expect(index.lookup("machines", "physical-600")?.ordinal).toBe(600);
    index.verifyDependencies();
  });

  it("encodes UTF8 byte order, null and signed numeric values without lexical bigint sorting", () => {
    const values: PortableOrderScalar[][] = [
      [{ $integer: "9223372036854775807" } as PortableOrderScalar],
      ["\u0100"], ["\u00ff"], ["a!"], ["a"], [null],
      [{ $integer: "10" } as PortableOrderScalar], [{ $integer: "2" } as PortableOrderScalar],
      [{ $integer: "-9223372036854775808" } as PortableOrderScalar],
    ];
    expect(values.sort((a, b) => encodePortableIndexOrder(a).compare(encodePortableIndexOrder(b))))
      .toEqual([[null], ["a"], ["a!"], ["\u00ff"], ["\u0100"], [{ $integer: "-9223372036854775808" }], [{ $integer: "2" }], [{ $integer: "10" }], [{ $integer: "9223372036854775807" }]]);
  });

  it("bounds page metadata bytes and rejects an oversized singleton", () => {
    const { index } = open();
    index.add("one", machine("one"));
    index.add("two", machine("two"));
    index.finalizeDomain("machines");
    const first = index.entries("machines", { afterOrdinal: -1, limit: 1, maxBytes: 10000 })[0];
    const bytes = Buffer.byteLength(JSON.stringify(first));
    expect(index.entries("machines", { afterOrdinal: -1, limit: 500, maxBytes: bytes })).toEqual([first]);
    expect(() => index.entries("machines", { afterOrdinal: -1, limit: 1, maxBytes: bytes - 1 })).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
  });

  it("rejects duplicate identities and missing foreign identities without exposing locator contents", () => {
    const { index } = open();
    index.add("private-canary", machine("m"));
    expect(() => index.add("other", machine("m"))).toThrow(expect.objectContaining({ code: "invalid-input" }));
    const other = open().index;
    const project = createPortableRecord({ domain: "project", ordinal: 0, value: { identity: { scope: "local", projectId: "a".repeat(64) } }, context: null });
    other.add("missing-parent", { ...project, dependencies: [{ domain: "machines", identitySha256: "a".repeat(64) }] });
    expect(() => other.verifyDependencies()).toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  it("assigns conversation occurrences by header then closure digest and compares digest matches", async () => {
    const { index } = open();
    const headerOrder = ["session", null, null, "2026-01-01T00:00:00.000000Z", "2026-01-01T00:00:00.000000Z"];
    index.addConversation({ locator: "late", headerOrder, closureSha256: "b".repeat(64) });
    index.addConversation({ locator: "early-one", headerOrder, closureSha256: "a".repeat(64) });
    index.addConversation({ locator: "early-two", headerOrder, closureSha256: "a".repeat(64) });
    await index.finalizeConversations(async () => true);
    expect(index.conversation("late")?.occurrenceOrdinal).toBe(2);
    expect(new Set([index.conversation("early-one")?.occurrenceOrdinal, index.conversation("early-two")?.occurrenceOrdinal])).toEqual(new Set([0, 1]));
    expect(index.allocateOccurrence("recall", "same")).toBe(0);
    expect(index.allocateOccurrence("recall", "same")).toBe(1);
    expect(index.allocateOccurrence("recall", "other")).toBe(0);
  });

  it("rejects forced closure digest collisions and destination relationship duplicates", async () => {
    const { index } = open();
    for (const locator of ["one", "two"]) index.addConversation({ locator, headerOrder: ["s", null, null, "t", "t"], closureSha256: "a".repeat(64) });
    await expect(index.finalizeConversations(async () => false)).rejects.toMatchObject({ code: "invalid-input" });
    const other = open().index;
    other.claimUnique("summary-target", "tuple");
    expect(() => other.claimUnique("summary-target", "tuple")).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
  });

  it("owns private scratch, cleans up idempotently, honors abort and rejects excess scratch budgets", () => {
    const { index, scratchParent } = open();
    const owned = join(scratchParent, readdirSync(scratchParent)[0]);
    expect(statSync(owned).mode & 0o777).toBe(0o700);
    index.close();
    index.close();
    expect(readdirSync(scratchParent)).toEqual([]);
    expect(() => index.lookup("machines", "one")).toThrow(expect.objectContaining({ code: "source-failed" }));
    const controller = new AbortController();
    const aborted = open({ signal: controller.signal }).index;
    controller.abort("private-canary");
    expect(() => aborted.add("x", machine("m"))).toThrow(expect.objectContaining({ code: "aborted" }));
    expect(() => open({ maxScratchBytes: 1 })).toThrow(expect.objectContaining({ code: "invalid-input" }));
    const small = open({ maxScratchBytes: 128 * 1024 }).index;
    expect(() => {
      for (let i = 0; i < 1000; i++) small.add(String(i), machine(`${i}-${"x".repeat(1024)}`));
    }).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
  });

  it("returns absent mappings and empty finalized domains without manufacturing records", async () => {
    const { index } = open();
    expect(index.lookup("machines", "missing")).toBeNull();
    expect(index.lookupIdentity("machines", "a".repeat(64))).toBeNull();
    index.finalizeDomain("project");
    expect(index.entries("project", { afterOrdinal: -1, limit: 1, maxBytes: 1000 })).toEqual([]);
    await index.finalizeConversations(async () => true);
    expect(index.conversation("missing")).toBeNull();
    expect(() => index.addConversation({ locator: "x", headerOrder: ["s", null, null, "t", "t"], closureSha256: "a".repeat(64) }))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  it("enforces finite byte and page limits, metadata limits, and finalized domain immutability", () => {
    for (const maxMetadataBytes of [0, -1, Infinity, 200 * 1024 * 1024]) {
      expect(() => open({ maxMetadataBytes })).toThrow(expect.objectContaining({ code: "invalid-input" }));
    }
    const { index } = open({ maxMetadataBytes: 128 });
    expect(() => index.add("x", machine("x".repeat(256)))).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
    const ready = open().index;
    ready.finalizeDomain("machines");
    for (const options of [
      { afterOrdinal: -2, limit: 1, maxBytes: 1000 },
      { afterOrdinal: -0, limit: 1, maxBytes: 1000 },
      { afterOrdinal: -1, limit: 501, maxBytes: 1000 },
      { afterOrdinal: -1, limit: 0, maxBytes: 1000 },
      { afterOrdinal: -1, limit: 1, maxBytes: 0 },
      { afterOrdinal: -1, limit: 1, maxBytes: 200 * 1024 * 1024 },
    ]) expect(() => ready.entries("machines", options)).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => ready.add("x", machine("x"))).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => open().index.entries("machines", { afterOrdinal: -1, limit: 1, maxBytes: 1000 }))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  it("rejects unknown domains, malformed hashes, bad dependencies and unfinished conversations", () => {
    const { index } = open();
    expect(() => index.finalizeDomain("not-a-domain" as never)).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => index.add("x", { ...machine("m"), identitySha256: "not-a-hash" }))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => index.add("x", { ...machine("m"), recordSha256: "not-a-hash" }))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => index.add("x", { ...machine("m"), dependencies: [{ domain: "project", identitySha256: "private-canary" }] }))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => open().index.conversation("missing")).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => open().index.addConversation({ locator: "x", headerOrder: [], closureSha256: "a".repeat(64) }))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => open().index.addConversation({ locator: "x", headerOrder: ["s", null, null, "t", "t"], closureSha256: "wrong" }))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  it("assigns 601 conversation members on disk, resetting occurrences for a distinct header", async () => {
    const { index } = open();
    for (let i = 600; i >= 0; i--) index.addConversation({ locator: String(i).padStart(3, "0"), headerOrder: ["s", null, null, "t", "t"], closureSha256: "a".repeat(64) });
    index.addConversation({ locator: "distinct", headerOrder: ["z", null, null, "t", "t"], closureSha256: "a".repeat(64) });
    await index.finalizeConversations(async () => true);
    expect(index.conversation("600")).toEqual({ occurrenceOrdinal: 600 });
    expect(index.conversation("distinct")).toEqual({ occurrenceOrdinal: 0 });
  });

  it("sanitizes failed collision comparisons and aborts while comparing large duplicate groups", async () => {
    const makeGroup = (signal?: AbortSignal) => {
      const { index } = open({ signal });
      for (const locator of ["one", "two"]) index.addConversation({ locator, headerOrder: ["s", null, null, "t", "t"], closureSha256: "a".repeat(64) });
      return index;
    };
    await expect(makeGroup().finalizeConversations(async () => { throw new Error("private-canary"); }))
      .rejects.toMatchObject({ code: "source-failed", message: "Portable transfer error: source-failed" });
    const controller = new AbortController();
    const index = makeGroup(controller.signal);
    await expect(index.finalizeConversations(async () => { controller.abort("private-canary"); return true; }))
      .rejects.toMatchObject({ code: "aborted" });
    const pageAbort = new AbortController();
    pageAbort.abort();
    expect(() => open().index.entries("machines", { afterOrdinal: -1, limit: 1, maxBytes: 1000, signal: pageAbort.signal }))
      .toThrow(expect.objectContaining({ code: "aborted" }));
    expect(() => open({ signal: pageAbort.signal })).toThrow(expect.objectContaining({ code: "aborted" }));
  });

  it("cleans failed scratch creation and sanitizes inaccessible scratch parents", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-index-failure-"));
    roots.push(parent);
    expect(() => createPortableIndex({ scratchParent: join(parent, "missing", "private-canary") }))
      .toThrow(expect.objectContaining({ code: "source-failed", message: "Portable transfer error: source-failed" }));
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => { throw new Error("private-canary"); });
    expect(() => createPortableIndex({ scratchParent: parent })).toThrow(expect.objectContaining({ code: "source-failed" }));
    exec.mockRestore();
    expect(readdirSync(parent)).toEqual([]);
  });

  it("sanitizes driver failures, poisons partial metadata and removes scratch after a close failure", () => {
    const { index, scratchParent } = open();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementationOnce(() => { throw new Error("private-canary"); });
    expect(() => index.lookup("machines", "x")).toThrow(expect.objectContaining({ code: "source-failed" }));
    prepare.mockRestore();
    expect(() => index.add("x", machine("x"))).toThrow(expect.objectContaining({ code: "source-failed" }));
    const nativeClose = DatabaseSync.prototype.close;
    const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function(this: DatabaseSync) {
      nativeClose.call(this);
      throw new Error("private-canary");
    });
    expect(() => index.close()).toThrow(expect.objectContaining({ code: "close-failed" }));
    close.mockRestore();
    expect(readdirSync(scratchParent)).toEqual([]);
  });


  it("bounds cumulative reconstructed array bytes independently per owner", () => {
    const { index } = open();
    index.consumeBudget("tags", "memory-one", 500, 1000);
    index.consumeBudget("tags", "memory-one", 500, 1000);
    index.consumeBudget("tags", "memory-two", 1000, 1000);
    expect(() => index.consumeBudget("tags", "memory-one", 1, 1000))
      .toThrow(expect.objectContaining({ code: "unsupported-capability" }));
    const other = open().index;
    for (const bytes of [-1, -0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => other.consumeBudget("tags", "memory", bytes, 1000))
        .toThrow(expect.objectContaining({ code: "invalid-input" }));
    }
    expect(() => other.consumeBudget("tags", "memory", 0, -1))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
    other.consumeBudget("tags", "empty", 0, 0);
    other.consumeBudget("tags", "huge", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(() => other.consumeBudget("tags", "huge", 1, Number.MAX_SAFE_INTEGER))
      .toThrow(expect.objectContaining({ code: "unsupported-capability" }));
  });

  it("reports sanitized cleanup failure instead of claiming scratch removal", () => {
    const { index } = open();
    vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error("private-canary"); });
    expect(() => index.close()).toThrow(expect.objectContaining({ code: "close-failed", message: "Portable transfer error: close-failed" }));
  });


  it("supports owned default scratch and preserves sanitized initialization failure if cleanup also fails", () => {
    const index = createPortableIndex();
    indexes.push(index);
    index.finalizeDomain("machines");
    expect(index.entries("machines", { afterOrdinal: -1, limit: 1, maxBytes: 1000 })).toEqual([]);
    const scratchParent = mkdtempSync(join(tmpdir(), "lcm-index-init-failure-"));
    roots.push(scratchParent);
    const nativeClose = DatabaseSync.prototype.close;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => { throw new Error("private-canary"); });
    const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function(this: DatabaseSync) {
      nativeClose.call(this);
      throw new Error("cleanup-canary");
    });
    expect(() => createPortableIndex({ scratchParent })).toThrow(expect.objectContaining({ code: "source-failed", message: "Portable transfer error: source-failed" }));
    close.mockRestore();
    exec.mockRestore();
    expect(readdirSync(scratchParent)).toEqual([]);
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => { throw new Error("private-canary"); });
    vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error("cleanup-canary"); });
    expect(() => createPortableIndex({ scratchParent })).toThrow(expect.objectContaining({ code: "source-failed" }));
  });


  it("validates delayed conversation membership without retaining record contents", () => {
    const { index } = open();
    index.requireScope("conversation", "message", "conversation-one");
    index.bindScope("conversation", "message", "conversation-one");
    expect(index.getScope("conversation", "message")).toBe("conversation-one");
    expect(index.getScope("conversation", "absent")).toBeNull();
    index.verifyScopesAndAcyclic();
    const mismatch = open().index;
    mismatch.bindScope("conversation", "message", "other-conversation");
    mismatch.requireScope("conversation", "message", "expected-conversation");
    expect(() => mismatch.verifyScopesAndAcyclic()).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
    const missing = open().index;
    missing.requireScope("conversation", "absent", "expected");
    expect(() => missing.verifyScopesAndAcyclic()).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
  });

  it("detects graph cycles through bounded disk elimination across more than 500 nodes", () => {
    const { index } = open();
    for (let i = 0; i < 600; i++) index.addEdge("summaries", String(i), String(i + 1));
    index.addEdge("summaries", "0", "1");
    index.addEdge("independent", "x", "y");
    index.verifyScopesAndAcyclic();
    index.verifyScopesAndAcyclic();
    index.addEdge("summaries", "600", "0");
    expect(() => index.verifyScopesAndAcyclic()).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
    const self = open().index;
    self.addEdge("summaries", "self", "self");
    expect(() => self.verifyScopesAndAcyclic()).toThrow(expect.objectContaining({ code: "unsupported-capability" }));
  });


  it("scrubs mutated typed errors from the external collision comparator", async () => {
    const { index } = open();
    for (const locator of ["one", "two"]) index.addConversation({ locator, headerOrder: ["s", null, null, "t", "t"], closureSha256: "a".repeat(64) });
    const error = new PortableTransferError("source-changed");
    error.message = "private-canary";
    await expect(index.finalizeConversations(async () => { throw error; }))
      .rejects.toMatchObject({ code: "source-changed", message: "Portable transfer error: source-changed" });
  });

});
